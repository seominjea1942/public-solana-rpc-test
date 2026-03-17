const { rateLimitedRpcPost } = require("../rate-limiter");
const { getSolUsdPrice } = require("../database");
const {
  readPublicKey, readU8, readU64,
  computeDiscriminator, SOL_MINT, USDC_MINT,
} = require("./utils");

const PROGRAM_ID = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";

// Stablecoins treated as ~$1 for USD price calculations
const STABLECOINS = new Set([
  USDC_MINT,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX",  // USDH
]);

// ── CPMM Pool Layout (Anchor: 8-byte discriminator + fields) ──
// Offsets calculated from the struct:
//   discriminator:      8 bytes  (0)
//   configId:          32 bytes  (8)
//   poolCreator:       32 bytes  (40)
//   vaultA:            32 bytes  (72)
//   vaultB:            32 bytes  (104)
//   mintLp:            32 bytes  (136)
//   mintA:             32 bytes  (168)
//   mintB:             32 bytes  (200)
//   mintProgramA:      32 bytes  (232)
//   mintProgramB:      32 bytes  (264)
//   observationId:     32 bytes  (296)
//   bump:               1 byte  (328)
//   status:             1 byte  (329)
//   lpDecimals:         1 byte  (330)
//   mintDecimalA:       1 byte  (331)
//   mintDecimalB:       1 byte  (332)
//   lpAmount:           8 bytes (333)
//   protocolFeesMintA:  8 bytes (341)
//   protocolFeesMintB:  8 bytes (349)
//   fundFeesMintA:      8 bytes (357)
//   fundFeesMintB:      8 bytes (365)
//   openTime:           8 bytes (373)

function decodeCpmm(base64Data) {
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length < 381) {
    throw new Error(`CPMM buffer too small: ${buffer.length} bytes, need >= 381`);
  }

  return {
    configId:      readPublicKey(buffer, 8),
    poolCreator:   readPublicKey(buffer, 40),
    vaultA:        readPublicKey(buffer, 72),
    vaultB:        readPublicKey(buffer, 104),
    mintLp:        readPublicKey(buffer, 136),
    mintA:         readPublicKey(buffer, 168),
    mintB:         readPublicKey(buffer, 200),
    mintProgramA:  readPublicKey(buffer, 232),
    mintProgramB:  readPublicKey(buffer, 264),
    observationId: readPublicKey(buffer, 296),
    bump:          readU8(buffer, 328),
    status:        readU8(buffer, 329),
    lpDecimals:    readU8(buffer, 330),
    mintDecimalA:  readU8(buffer, 331),
    mintDecimalB:  readU8(buffer, 332),
    lpAmount:      readU64(buffer, 333),
  };
}

/**
 * Full parse pipeline for Raydium CPMM:
 *  1. Decode binary layout
 *  2. Query vault balances (2 rate-limited RPC calls)
 *  3. Calculate price (supports SOL/USDC and TOKEN/SOL pairs)
 *
 * For SOL/USDC pairs: price = USDC per SOL (same as other parsers)
 * For TOKEN/SOL pairs: price = USD per TOKEN (uses SOL price from DB)
 */
async function parseRaydiumCpmm(rpcUrl, base64Data, slot) {
  const decoded = decodeCpmm(base64Data);

  // Fetch vault balances in parallel
  const [vaultAResult, vaultBResult] = await Promise.all([
    rateLimitedRpcPost(rpcUrl, "getTokenAccountBalance", [decoded.vaultA]),
    rateLimitedRpcPost(rpcUrl, "getTokenAccountBalance", [decoded.vaultB]),
  ]);

  if (!vaultAResult.success) throw new Error(`VaultA balance failed: ${vaultAResult.error}`);
  if (!vaultBResult.success) throw new Error(`VaultB balance failed: ${vaultBResult.error}`);

  const amountA = parseFloat(vaultAResult.data.value.uiAmountString || "0");
  const amountB = parseFloat(vaultBResult.data.value.uiAmountString || "0");

  // Determine pair type and price direction
  const isSolA = decoded.mintA === SOL_MINT;
  const isSolB = decoded.mintB === SOL_MINT;
  const isStableA = STABLECOINS.has(decoded.mintA);
  const isStableB = STABLECOINS.has(decoded.mintB);

  let baseMint, quoteMint, baseVault, quoteVault;
  let baseDecimal, quoteDecimal, baseAmount, quoteAmount;
  let baseAmountRaw, quoteAmountRaw;
  let price, liquidityUsd;

  if (isStableA || isStableB) {
    // ── SOL/USDC or TOKEN/USDC pair ──
    // SOL (or token) is base, stablecoin is quote
    const solIsBase = isStableB; // if B is stable, A is base
    baseMint = solIsBase ? decoded.mintA : decoded.mintB;
    quoteMint = solIsBase ? decoded.mintB : decoded.mintA;
    baseVault = solIsBase ? decoded.vaultA : decoded.vaultB;
    quoteVault = solIsBase ? decoded.vaultB : decoded.vaultA;
    baseDecimal = solIsBase ? decoded.mintDecimalA : decoded.mintDecimalB;
    quoteDecimal = solIsBase ? decoded.mintDecimalB : decoded.mintDecimalA;
    baseAmount = solIsBase ? amountA : amountB;
    quoteAmount = solIsBase ? amountB : amountA;
    baseAmountRaw = solIsBase ? vaultAResult.data.value.amount : vaultBResult.data.value.amount;
    quoteAmountRaw = solIsBase ? vaultBResult.data.value.amount : vaultAResult.data.value.amount;

    // Price = stablecoin per base token ≈ USD per base token
    price = baseAmount > 0 ? quoteAmount / baseAmount : 0;
    liquidityUsd = quoteAmount * 2;
  } else if (isSolA || isSolB) {
    // ── TOKEN/SOL pair (e.g., USELESS/SOL) ──
    // Non-SOL token is base, SOL is quote
    const tokenIsA = isSolB; // if B is SOL, A is the token
    baseMint = tokenIsA ? decoded.mintA : decoded.mintB;
    quoteMint = tokenIsA ? decoded.mintB : decoded.mintA;
    baseVault = tokenIsA ? decoded.vaultA : decoded.vaultB;
    quoteVault = tokenIsA ? decoded.vaultB : decoded.vaultA;
    baseDecimal = tokenIsA ? decoded.mintDecimalA : decoded.mintDecimalB;
    quoteDecimal = tokenIsA ? decoded.mintDecimalB : decoded.mintDecimalA;
    baseAmount = tokenIsA ? amountA : amountB;
    quoteAmount = tokenIsA ? amountB : amountA; // SOL amount
    baseAmountRaw = tokenIsA ? vaultAResult.data.value.amount : vaultBResult.data.value.amount;
    quoteAmountRaw = tokenIsA ? vaultBResult.data.value.amount : vaultAResult.data.value.amount;

    // price_in_sol = SOL per 1 base token
    const priceInSol = baseAmount > 0 ? quoteAmount / baseAmount : 0;

    // Convert to USD using SOL price from DB
    const solUsd = getSolUsdPrice();
    if (solUsd && solUsd > 0) {
      price = priceInSol * solUsd;
      liquidityUsd = quoteAmount * solUsd * 2;
    } else {
      // Fallback: store in SOL terms, mark approximate
      price = priceInSol;
      liquidityUsd = quoteAmount * 2; // in SOL, not USD
    }
  } else {
    // ── Other pair (neither SOL nor stablecoin) ──
    baseMint = decoded.mintA;
    quoteMint = decoded.mintB;
    baseVault = decoded.vaultA;
    quoteVault = decoded.vaultB;
    baseDecimal = decoded.mintDecimalA;
    quoteDecimal = decoded.mintDecimalB;
    baseAmount = amountA;
    quoteAmount = amountB;
    baseAmountRaw = vaultAResult.data.value.amount;
    quoteAmountRaw = vaultBResult.data.value.amount;
    price = baseAmount > 0 ? quoteAmount / baseAmount : 0;
    liquidityUsd = 0; // Can't estimate USD without a reference price
  }

  return {
    baseMint,
    quoteMint,
    lpMint: decoded.mintLp,
    baseVault,
    quoteVault,
    baseDecimal,
    quoteDecimal,
    baseAmount,
    quoteAmount,
    baseAmountRaw,
    quoteAmountRaw,
    price,
    liquidityUsd,
    feeRate: 0, // CPMM fee is configured in the config account, not in pool state
    status: decoded.status,
    lpReserve: decoded.lpAmount.toString(),
    openOrders: null,
    marketId: null,
    slot: slot || null,
    parseSuccess: true,
  };
}

// ── Transaction classification ──

const CPMM_DISCRIMINATORS = {
  swapBaseInput:  computeDiscriminator("global:swap_base_input"),
  swapBaseOutput: computeDiscriminator("global:swap_base_output"),
  deposit:        computeDiscriminator("global:deposit"),
  withdraw:       computeDiscriminator("global:withdraw"),
  initialize:     computeDiscriminator("global:initialize"),
};

function identifyCpmmInstruction(instructionData) {
  if (!instructionData || instructionData.length < 8) return "unknown";
  const disc = Buffer.isBuffer(instructionData)
    ? instructionData.slice(0, 8)
    : Buffer.from(instructionData).slice(0, 8);

  for (const [name, expected] of Object.entries(CPMM_DISCRIMINATORS)) {
    if (disc.equals(expected)) return name;
  }
  return "unknown";
}

/**
 * Classify CPMM transaction from logs + inner instructions + account keys.
 *
 * CPMM logs use Anchor instruction names like "Instruction: SwapBaseInput",
 * "Instruction: Deposit", "Instruction: Withdraw".
 *
 * Many CPMM swaps go through DEX aggregators (e.g., Jupiter) which can
 * truncate inner instruction logs. In that case, we fall back to checking:
 *  1. Whether CPMM is in account keys
 *  2. Whether token balance changes exist (confirms actual swap vs. price check)
 */
function classifyCpmmTx(txData) {
  if (!txData || !txData.meta) return "unparsed";
  if (txData.meta.err) return "failed";

  const logs = txData.meta.logMessages || [];

  // Track if we're inside CPMM program context
  let inCpmmProgram = false;

  for (const log of logs) {
    // Detect CPMM program invocation
    if (log.includes("Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C invoke")) {
      inCpmmProgram = true;
      continue;
    }
    if (log.includes("Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C success") ||
        log.includes("Program CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C failed")) {
      inCpmmProgram = false;
      continue;
    }

    const lower = log.toLowerCase();

    // Check CPMM-specific Anchor instruction names
    if (lower.includes("instruction: swapbaseinput") || lower.includes("instruction: swapbaseoutput")) {
      return "swap";
    }
    if (lower.includes("instruction: deposit")) {
      if (inCpmmProgram) return "add_liquidity";
    }
    if (lower.includes("instruction: withdraw")) {
      if (inCpmmProgram) return "remove_liquidity";
    }
    if (lower.includes("instruction: initialize")) {
      if (inCpmmProgram) return "initialize";
    }

    // Fallback: generic swap detection in CPMM context
    if (inCpmmProgram && (lower.includes("swap_base_input") || lower.includes("swap_base_output"))) {
      return "swap";
    }

    // Also catch generic swap/deposit/withdraw keywords (from aggregator logs)
    if (lower.includes("swap") && (inCpmmProgram || log.includes(PROGRAM_ID))) {
      return "swap";
    }
  }

  // ── Fallback: Log-truncated aggregator transactions ──
  // Many DEX aggregator txns truncate inner CPI logs.
  // If CPMM is in account keys AND there are token balance changes,
  // it's almost certainly a swap routed through an aggregator.
  const acctKeys = txData.transaction?.message?.accountKeys || [];
  const hasCpmmKey = acctKeys.some(
    (k) => (k.pubkey || k) === PROGRAM_ID
  );

  if (hasCpmmKey) {
    // Check if actual token balance changes occurred (not just a price check)
    const preBalances = txData.meta.preTokenBalances || [];
    const postBalances = txData.meta.postTokenBalances || [];

    let hasBalanceChange = false;
    for (const post of postBalances) {
      const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
      const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmountString || "0");
      const postAmt = parseFloat(post?.uiTokenAmount?.uiAmountString || "0");
      if (Math.abs(postAmt - preAmt) > 0.000001) {
        hasBalanceChange = true;
        break;
      }
    }

    if (hasBalanceChange) {
      return "swap"; // Aggregator-routed swap with truncated logs
    }
  }

  return "other";
}

module.exports = {
  programId: PROGRAM_ID,
  decodeCpmm,
  parseRaydiumCpmm,
  classifyCpmmTx,
  identifyCpmmInstruction,
  CPMM_DISCRIMINATORS,
};
