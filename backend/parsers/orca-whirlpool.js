const { rateLimitedRpcPost } = require("../rate-limiter");
const {
  readPublicKey, readU8, readU16, readI32, readU64, readU128,
  computeDiscriminator, SOL_MINT,
} = require("./utils");

const PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

// ── Whirlpool Pool Layout (Anchor: 8-byte discriminator + fields) ──
// Fields are interleaved per token (mintA, vaultA, feeGrowthA, then mintB, vaultB, feeGrowthB).
// Verified empirically against on-chain data.
//
// Offsets:
//   discriminator:       8 bytes  (0)
//   whirlpoolsConfig:   32 bytes  (8)
//   whirlpoolBump:       1 byte   (40)
//   tickSpacing:         2 bytes  (41)
//   tickSpacingSeed:     2 bytes  (43)
//   feeRate:             2 bytes  (45)   u16
//   protocolFeeRate:     2 bytes  (47)   u16
//   liquidity:          16 bytes  (49)   u128
//   sqrtPrice:          16 bytes  (65)   u128
//   tickCurrentIndex:    4 bytes  (81)   i32
//   protocolFeeOwedA:    8 bytes  (85)   u64
//   protocolFeeOwedB:    8 bytes  (93)   u64
//   tokenMintA:         32 bytes  (101)
//   tokenVaultA:        32 bytes  (133)
//   feeGrowthGlobalA:   16 bytes  (165)  u128
//   tokenMintB:         32 bytes  (181)
//   tokenVaultB:        32 bytes  (213)
//   feeGrowthGlobalB:   16 bytes  (245)  u128
// Total through feeGrowthGlobalB: 261 bytes

function decodeWhirlpool(base64Data) {
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length < 261) {
    throw new Error(`Whirlpool buffer too small: ${buffer.length} bytes, need >= 261`);
  }

  const feeRateRaw = readU16(buffer, 45);
  // Whirlpool feeRate is in hundredths of a basis point
  // 1 basis point = 0.01%, so feeRate of 3000 = 3000/1000000 = 0.3%
  const feeRate = feeRateRaw / 1_000_000;

  return {
    whirlpoolsConfig: readPublicKey(buffer, 8),
    whirlpoolBump:    readU8(buffer, 40),
    tickSpacing:      readU16(buffer, 41),
    feeRateRaw,
    feeRate,
    protocolFeeRate:  readU16(buffer, 47),
    liquidity:        readU128(buffer, 49),
    sqrtPrice:        readU128(buffer, 65),
    tickCurrentIndex: readI32(buffer, 81),
    protocolFeeOwedA: readU64(buffer, 85),
    protocolFeeOwedB: readU64(buffer, 93),
    tokenMintA:       readPublicKey(buffer, 101),
    tokenVaultA:      readPublicKey(buffer, 133),
    tokenMintB:       readPublicKey(buffer, 181),
    tokenVaultB:      readPublicKey(buffer, 213),
  };
}

/**
 * Calculate price from Whirlpool sqrtPrice (Q64.64 fixed-point u128).
 *
 * sqrtPrice represents sqrt(price) where price = tokenB / tokenA in atomic units.
 *
 * price_atomic = sqrtPrice^2 / 2^128
 * price_human  = price_atomic * 10^(decimalsA - decimalsB)
 *
 * This gives: amount of token B per 1 token A (in human-readable units).
 * e.g., if A=SOL(9 dec), B=USDC(6 dec): result = USDC per SOL ≈ 94.9
 */
function priceFromSqrtPrice(sqrtPriceX64, decimalsA, decimalsB) {
  const sqrtPrice = BigInt(sqrtPriceX64);
  const priceX128 = sqrtPrice * sqrtPrice;
  const shift = BigInt(2) ** BigInt(128);

  // price_atomic in floating point
  // Use string conversion for large BigInts to avoid precision loss
  const priceRaw = Number(priceX128 * 1000000000000n / shift) / 1000000000000;

  // Adjust for decimal difference
  const decimalAdjustment = Math.pow(10, decimalsA - decimalsB);
  return priceRaw * decimalAdjustment;
}

/**
 * Full parse pipeline for Orca Whirlpool:
 *  1. Decode binary layout -> extract sqrtPrice, mints, vaults
 *  2. Calculate price from sqrtPrice
 *  3. Query vault balances for liquidity calculation (2 rate-limited RPC calls)
 */
async function parseOrcaWhirlpool(rpcUrl, base64Data, slot) {
  const decoded = decodeWhirlpool(base64Data);

  // Fetch vault balances for liquidity
  const [vaultAResult, vaultBResult] = await Promise.all([
    rateLimitedRpcPost(rpcUrl, "getTokenAccountBalance", [decoded.tokenVaultA]),
    rateLimitedRpcPost(rpcUrl, "getTokenAccountBalance", [decoded.tokenVaultB]),
  ]);

  if (!vaultAResult.success) throw new Error(`VaultA balance failed: ${vaultAResult.error}`);
  if (!vaultBResult.success) throw new Error(`VaultB balance failed: ${vaultBResult.error}`);

  const amountA = parseFloat(vaultAResult.data.value.uiAmountString || "0");
  const amountB = parseFloat(vaultBResult.data.value.uiAmountString || "0");
  const decimalsA = parseInt(vaultAResult.data.value.decimals);
  const decimalsB = parseInt(vaultBResult.data.value.decimals);

  // Calculate price from sqrtPrice
  // This gives: amount of tokenA per 1 tokenB
  let rawPrice = priceFromSqrtPrice(decoded.sqrtPrice, decimalsA, decimalsB);

  // Determine direction: we want USDC per SOL
  const isSolA = decoded.tokenMintA === SOL_MINT;
  let price;
  let baseAmount, quoteAmount;

  if (isSolA) {
    // A=SOL, B=USDC
    // rawPrice = tokenB per tokenA (adjusted) = USDC per SOL (what we want!)
    price = rawPrice;
    baseAmount = amountA;
    quoteAmount = amountB;
  } else {
    // A=USDC, B=SOL
    // rawPrice = tokenB per tokenA = SOL per USDC, so invert
    price = rawPrice > 0 ? 1 / rawPrice : 0;
    baseAmount = amountB;
    quoteAmount = amountA;
  }

  // Sanity check: if price is unreasonable, try inverse
  if (price < 0.01 || price > 100000) {
    const inverse = price > 0 ? 1 / price : 0;
    if (inverse > 10 && inverse < 10000) {
      console.warn(`[Whirlpool] Price ${price.toFixed(4)} seems wrong, using inverse ${inverse.toFixed(4)}`);
      price = inverse;
      // Swap base/quote amounts
      const tmp = baseAmount;
      baseAmount = quoteAmount;
      quoteAmount = tmp;
    }
  }

  const liquidityUsd = quoteAmount * 2;

  return {
    baseMint: isSolA ? decoded.tokenMintA : decoded.tokenMintB,
    quoteMint: isSolA ? decoded.tokenMintB : decoded.tokenMintA,
    lpMint: null,
    baseVault: isSolA ? decoded.tokenVaultA : decoded.tokenVaultB,
    quoteVault: isSolA ? decoded.tokenVaultB : decoded.tokenVaultA,
    baseDecimal: isSolA ? decimalsA : decimalsB,
    quoteDecimal: isSolA ? decimalsB : decimalsA,
    baseAmount,
    quoteAmount,
    baseAmountRaw: isSolA ? vaultAResult.data.value.amount : vaultBResult.data.value.amount,
    quoteAmountRaw: isSolA ? vaultBResult.data.value.amount : vaultAResult.data.value.amount,
    price,
    liquidityUsd,
    feeRate: decoded.feeRate,
    status: 6, // Whirlpools don't have a simple status field; 6 = active equivalent
    lpReserve: null,
    openOrders: null,
    marketId: null,
    slot: slot || null,
    parseSuccess: true,
    // Extra Whirlpool-specific fields
    tickCurrentIndex: decoded.tickCurrentIndex,
    tickSpacing: decoded.tickSpacing,
    sqrtPrice: decoded.sqrtPrice.toString(),
    liquidityRaw: decoded.liquidity.toString(),
  };
}

// ── Transaction classification ──

const WHIRLPOOL_DISCRIMINATORS = {
  swap:              computeDiscriminator("global:swap"),
  twoHopSwap:        computeDiscriminator("global:two_hop_swap"),
  increaseLiquidity: computeDiscriminator("global:increase_liquidity"),
  decreaseLiquidity: computeDiscriminator("global:decrease_liquidity"),
  openPosition:      computeDiscriminator("global:open_position"),
  closePosition:     computeDiscriminator("global:close_position"),
};

function identifyWhirlpoolInstruction(instructionData) {
  if (!instructionData || instructionData.length < 8) return "unknown";
  const disc = Buffer.isBuffer(instructionData)
    ? instructionData.slice(0, 8)
    : Buffer.from(instructionData).slice(0, 8);

  for (const [name, expected] of Object.entries(WHIRLPOOL_DISCRIMINATORS)) {
    if (disc.equals(expected)) return name;
  }
  return "unknown";
}

/**
 * Classify Whirlpool transaction from log messages.
 */
function classifyWhirlpoolTx(txData) {
  if (!txData || !txData.meta) return "unparsed";
  if (txData.meta.err) return "failed";

  const logs = txData.meta.logMessages || [];
  for (const log of logs) {
    const lower = log.toLowerCase();
    if (lower.includes("swap") || lower.includes("two_hop_swap")) {
      return "swap";
    }
    if (lower.includes("increase_liquidity") || lower.includes("open_position")) {
      return "add_liquidity";
    }
    if (lower.includes("decrease_liquidity") || lower.includes("close_position")) {
      return "remove_liquidity";
    }
    if (lower.includes("initialize")) {
      return "initialize";
    }
  }

  // Fallback: aggregator transactions may truncate inner CPI logs.
  // Check if Whirlpool program is in account keys + token balance changes.
  const acctKeys = txData.transaction?.message?.accountKeys || [];
  const hasWhirlpoolKey = acctKeys.some(
    (k) => (k.pubkey || k) === PROGRAM_ID
  );

  if (hasWhirlpoolKey) {
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
  decodeWhirlpool,
  parseOrcaWhirlpool,
  priceFromSqrtPrice,
  classifyWhirlpoolTx,
  identifyWhirlpoolInstruction,
  WHIRLPOOL_DISCRIMINATORS,
};
