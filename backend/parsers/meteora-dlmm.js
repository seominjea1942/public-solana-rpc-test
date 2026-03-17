const { rateLimitedRpcPost } = require("../rate-limiter");
const {
  readPublicKey, readU8, readU16, readI32, readU64,
  computeDiscriminator, SOL_MINT,
} = require("./utils");

const PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

// ── Meteora DLMM LbPair Layout (Anchor: 8-byte discriminator + fields) ──
//
// The layout starts with two nested structs (StaticParameters + VariableParameters),
// followed by scalar fields and then the token mint/vault public keys.
//
// StaticParameters (30 bytes):
//   baseFactor:                 u16  (2)
//   filterPeriod:               u16  (2)
//   decayPeriod:                u16  (2)
//   reductionFactor:            u16  (2)
//   variableFeeControl:         u32  (4)
//   maxVolatilityAccumulator:   u32  (4)
//   minBinId:                   i32  (4)
//   maxBinId:                   i32  (4)
//   protocolShare:              u16  (2)
//   padding:                    [u8; 6] (6)
//
// VariableParameters (32 bytes):
//   volatilityAccumulator:      u32  (4)
//   volatilityReference:        u32  (4)
//   indexReference:              i32  (4)
//   padding:                    [u8; 4] (4)
//   lastUpdateTimestamp:         i64  (8)
//   padding1:                   [u8; 8] (8)
//
// Then scalar fields:
//   bumpSeed:          [u8; 1]  (1)
//   binStepSeed:       [u8; 2]  (2)
//   pairType:          u8       (1)
//   activeId:          i32      (4)
//   binStep:           u16      (2)
//   status:            u8       (1)
//   requireBaseFactorSeed: u8   (1)
//   baseFactorSeed:    [u8; 2]  (2)
//   padding1:          [u8; 2]  (2)
//   tokenXMint:        Pubkey   (32)
//   tokenYMint:        Pubkey   (32)
//   reserveX:          Pubkey   (32)
//   reserveY:          Pubkey   (32)
//
// Offsets (verified empirically against on-chain data):
//   discriminator:   0    (8 bytes)
//   staticParams:    8    (32 bytes) -> ends at 40
//   variableParams:  40   (32 bytes) -> ends at 72
//   bumpSeed:        72   (1 byte)
//   binStepSeed:     73   (2 bytes)
//   pairType:        75   (1 byte)
//   activeId:        76   (4 bytes, i32)
//   binStep:         80   (2 bytes, u16)
//   status:          82   (1 byte)
//   requireBaseFactorSeed: 83 (1 byte)
//   baseFactorSeed:  84   (2 bytes)
//   padding1:        86   (2 bytes)
//   tokenXMint:      88   (32 bytes)
//   tokenYMint:      120  (32 bytes)
//   reserveX:        152  (32 bytes) — vault for token X
//   reserveY:        184  (32 bytes) — vault for token Y

function decodeMeteoraDlmm(base64Data) {
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length < 216) {
    throw new Error(`DLMM buffer too small: ${buffer.length} bytes, need >= 216`);
  }

  // StaticParameters extraction (for bin range info)
  const baseFactor = readU16(buffer, 8);
  const minBinId = readI32(buffer, 22);
  const maxBinId = readI32(buffer, 26);
  const protocolShare = readU16(buffer, 30);

  // Scalar fields
  const pairType = readU8(buffer, 75);
  const activeId = readI32(buffer, 76);
  const binStep = readU16(buffer, 80);
  const status = readU8(buffer, 82);

  // Token mints and vaults
  const tokenXMint = readPublicKey(buffer, 88);
  const tokenYMint = readPublicKey(buffer, 120);
  const reserveX = readPublicKey(buffer, 152);
  const reserveY = readPublicKey(buffer, 184);

  return {
    baseFactor,
    minBinId,
    maxBinId,
    protocolShare,
    pairType,
    activeId,
    binStep,
    status,
    tokenXMint,
    tokenYMint,
    reserveX,   // vault for token X
    reserveY,   // vault for token Y
  };
}

/**
 * Calculate price from DLMM bin parameters.
 *
 * DLMM uses a bin-based system:
 *   price = (1 + binStep/10000) ^ activeId * 10^(decimalsX - decimalsY)
 *
 * activeId is a signed i32 representing the current active bin.
 * For SOL/USDC at ~$95, activeId ≈ -2356 with binStep=10:
 *   1.001^(-2356) * 10^(9-6) ≈ 94.9
 *
 * The raw price gives: amount of token Y per 1 token X (in human-readable units).
 */
function priceFromBin(activeId, binStep, decimalsX, decimalsY) {
  const binStepRate = 1 + binStep / 10000;
  const rawPrice = Math.pow(binStepRate, activeId);
  return rawPrice * Math.pow(10, decimalsX - decimalsY);
}

/**
 * Full parse pipeline for Meteora DLMM:
 *  1. Decode binary layout -> extract activeId, binStep, mints, vaults
 *  2. Calculate price from bin parameters
 *  3. Query vault balances for liquidity (2 rate-limited RPC calls)
 */
async function parseMeteoraDlmm(rpcUrl, base64Data, slot) {
  const decoded = decodeMeteoraDlmm(base64Data);

  // Fetch vault balances
  const [vaultXResult, vaultYResult] = await Promise.all([
    rateLimitedRpcPost(rpcUrl, "getTokenAccountBalance", [decoded.reserveX]),
    rateLimitedRpcPost(rpcUrl, "getTokenAccountBalance", [decoded.reserveY]),
  ]);

  if (!vaultXResult.success) throw new Error(`VaultX balance failed: ${vaultXResult.error}`);
  if (!vaultYResult.success) throw new Error(`VaultY balance failed: ${vaultYResult.error}`);

  const amountX = parseFloat(vaultXResult.data.value.uiAmountString || "0");
  const amountY = parseFloat(vaultYResult.data.value.uiAmountString || "0");
  const decimalsX = parseInt(vaultXResult.data.value.decimals);
  const decimalsY = parseInt(vaultYResult.data.value.decimals);

  // Calculate price from bin
  // priceFromBin gives: token Y per token X
  let rawPrice = priceFromBin(decoded.activeId, decoded.binStep, decimalsX, decimalsY);

  // Determine direction: we want USDC per SOL
  const isSolX = decoded.tokenXMint === SOL_MINT;
  let price;
  let baseAmount, quoteAmount;

  if (isSolX) {
    // X=SOL, Y=USDC
    // rawPrice = Y per X = USDC per SOL (what we want!)
    price = rawPrice;
    baseAmount = amountX;
    quoteAmount = amountY;
  } else {
    // X=USDC, Y=SOL
    // rawPrice = Y per X = SOL per USDC, invert
    price = rawPrice > 0 ? 1 / rawPrice : 0;
    baseAmount = amountY;
    quoteAmount = amountX;
  }

  // Sanity check
  if (price < 0.01 || price > 100000) {
    const inverse = price > 0 ? 1 / price : 0;
    if (inverse > 10 && inverse < 10000) {
      console.warn(`[DLMM] Price ${price.toFixed(4)} seems wrong, using inverse ${inverse.toFixed(4)}`);
      price = inverse;
      const tmp = baseAmount;
      baseAmount = quoteAmount;
      quoteAmount = tmp;
    }
  }

  const liquidityUsd = quoteAmount * 2;

  // Fee rate from bin step
  // Base fee = baseFactor * binStep * 10 / 1e9 (approximate)
  const feeRate = decoded.baseFactor > 0
    ? (decoded.baseFactor * decoded.binStep * 10) / 1e9
    : decoded.binStep / 10000;

  return {
    baseMint: isSolX ? decoded.tokenXMint : decoded.tokenYMint,
    quoteMint: isSolX ? decoded.tokenYMint : decoded.tokenXMint,
    lpMint: null,
    baseVault: isSolX ? decoded.reserveX : decoded.reserveY,
    quoteVault: isSolX ? decoded.reserveY : decoded.reserveX,
    baseDecimal: isSolX ? decimalsX : decimalsY,
    quoteDecimal: isSolX ? decimalsY : decimalsX,
    baseAmount,
    quoteAmount,
    baseAmountRaw: isSolX ? vaultXResult.data.value.amount : vaultYResult.data.value.amount,
    quoteAmountRaw: isSolX ? vaultYResult.data.value.amount : vaultXResult.data.value.amount,
    price,
    liquidityUsd,
    feeRate,
    status: decoded.status,
    lpReserve: null,
    openOrders: null,
    marketId: null,
    slot: slot || null,
    parseSuccess: true,
    // Extra DLMM-specific fields
    activeId: decoded.activeId,
    binStep: decoded.binStep,
    pairType: decoded.pairType,
    minBinId: decoded.minBinId,
    maxBinId: decoded.maxBinId,
  };
}

// ── Transaction classification ──

const METEORA_DISCRIMINATORS = {
  swap:             computeDiscriminator("global:swap"),
  addLiquidity:     computeDiscriminator("global:add_liquidity"),
  removeLiquidity:  computeDiscriminator("global:remove_liquidity"),
  initializeLbPair: computeDiscriminator("global:initialize_lb_pair"),
  addLiquidityByWeight:    computeDiscriminator("global:add_liquidity_by_weight"),
  addLiquidityByStrategy:  computeDiscriminator("global:add_liquidity_by_strategy"),
  removeLiquidityByRange:  computeDiscriminator("global:remove_liquidity_by_range"),
};

function identifyMeteoraInstruction(instructionData) {
  if (!instructionData || instructionData.length < 8) return "unknown";
  const disc = Buffer.isBuffer(instructionData)
    ? instructionData.slice(0, 8)
    : Buffer.from(instructionData).slice(0, 8);

  for (const [name, expected] of Object.entries(METEORA_DISCRIMINATORS)) {
    if (disc.equals(expected)) return name;
  }
  return "unknown";
}

/**
 * Classify Meteora DLMM transaction from log messages.
 */
function classifyMeteoraTx(txData) {
  if (!txData || !txData.meta) return "unparsed";
  if (txData.meta.err) return "failed";

  const logs = txData.meta.logMessages || [];
  for (const log of logs) {
    const lower = log.toLowerCase();
    // Check swap first (more common)
    if (lower.includes("swap")) {
      return "swap";
    }
    if (lower.includes("add_liquidity") || lower.includes("addliquidity")) {
      return "add_liquidity";
    }
    if (lower.includes("remove_liquidity") || lower.includes("removeliquidity")) {
      return "remove_liquidity";
    }
    if (lower.includes("initialize_lb_pair") || lower.includes("initialize")) {
      return "initialize";
    }
  }

  // Fallback: aggregator transactions may truncate inner CPI logs.
  // Check if Meteora DLMM program is in account keys + token balance changes.
  const acctKeys = txData.transaction?.message?.accountKeys || [];
  const hasMeteoraKey = acctKeys.some(
    (k) => (k.pubkey || k) === PROGRAM_ID
  );

  if (hasMeteoraKey) {
    const preBalances = txData.meta.preTokenBalances || [];
    const postBalances = txData.meta.postTokenBalances || [];
    for (const post of postBalances) {
      const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
      const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmountString || "0");
      const postAmt = parseFloat(post?.uiTokenAmount?.uiAmountString || "0");
      if (Math.abs(postAmt - preAmt) > 0.000001) {
        return "swap";
      }
    }
  }

  return "other";
}

module.exports = {
  programId: PROGRAM_ID,
  decodeMeteoraDlmm,
  parseMeteoraDlmm,
  priceFromBin,
  classifyMeteoraTx,
  identifyMeteoraInstruction,
  METEORA_DISCRIMINATORS,
};
