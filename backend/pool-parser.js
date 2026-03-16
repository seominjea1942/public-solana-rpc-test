const { LIQUIDITY_STATE_LAYOUT_V4 } = require("@raydium-io/raydium-sdk");
const { rateLimitedRpcPost } = require("./rate-limiter");

/**
 * Decode Raydium AMM v4 pool state from raw base64 account data.
 * Returns structured pool state with vault addresses, mints, decimals, fees.
 */
function decodeAmmV4(base64Data) {
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length < LIQUIDITY_STATE_LAYOUT_V4.span) {
    throw new Error(`Buffer too small: ${buffer.length} bytes, need ${LIQUIDITY_STATE_LAYOUT_V4.span}`);
  }
  return LIQUIDITY_STATE_LAYOUT_V4.decode(buffer);
}

/**
 * Fetch token account balance via rate-limited JSON-RPC call.
 * Goes through the global rate limiter before hitting the RPC.
 */
async function getTokenAccountBalance(rpcUrl, vaultAddress) {
  const result = await rateLimitedRpcPost(rpcUrl, "getTokenAccountBalance", [vaultAddress]);
  if (!result.success) {
    throw new Error(result.error || "Failed to get token account balance");
  }
  return result.data.value;
}

/**
 * Full parse pipeline for Raydium AMM v4:
 *  1. Decode binary layout -> structured fields
 *  2. Query vault balances (2 rate-limited RPC calls)
 *  3. Calculate price = quoteAmount / baseAmount
 *
 * @param {string} rpcUrl - RPC endpoint to query vault balances
 * @param {string} base64Data - Raw base64 account data
 * @param {number} slot - Slot at which account data was fetched
 * @returns {object} Parsed pool state with price
 */
async function parseRaydiumAmmV4(rpcUrl, base64Data, slot) {
  const poolState = decodeAmmV4(base64Data);

  const baseVault = poolState.baseVault.toBase58();
  const quoteVault = poolState.quoteVault.toBase58();
  const baseMint = poolState.baseMint.toBase58();
  const quoteMint = poolState.quoteMint.toBase58();
  const lpMint = poolState.lpMint.toBase58();

  const baseDecimal = poolState.baseDecimal.toNumber();
  const quoteDecimal = poolState.quoteDecimal.toNumber();

  // Fee rate
  const tradeFeeNum = poolState.tradeFeeNumerator.toNumber();
  const tradeFeeDen = poolState.tradeFeeDenominator.toNumber();
  const feeRate = tradeFeeDen > 0 ? tradeFeeNum / tradeFeeDen : 0;

  const status = poolState.status.toNumber();
  const lpReserve = poolState.lpReserve.toString();
  const openOrders = poolState.openOrders.toBase58();
  const marketId = poolState.marketId.toBase58();

  // Fetch vault balances (2 parallel rate-limited RPC calls)
  const [baseBalance, quoteBalance] = await Promise.all([
    getTokenAccountBalance(rpcUrl, baseVault),
    getTokenAccountBalance(rpcUrl, quoteVault),
  ]);

  const baseAmount = parseFloat(baseBalance.uiAmountString || "0");
  const quoteAmount = parseFloat(quoteBalance.uiAmountString || "0");

  // Price = quote / base (e.g. USDC per SOL)
  const price = baseAmount > 0 ? quoteAmount / baseAmount : 0;

  // Total liquidity ~= quote x 2 (balanced AMM pool)
  const liquidityUsd = quoteAmount * 2;

  return {
    baseMint,
    quoteMint,
    lpMint,
    baseVault,
    quoteVault,
    baseDecimal,
    quoteDecimal,
    baseAmount,
    quoteAmount,
    baseAmountRaw: baseBalance.amount,
    quoteAmountRaw: quoteBalance.amount,
    price,
    liquidityUsd,
    feeRate,
    status,
    lpReserve,
    openOrders,
    marketId,
    slot: slot || null,
    parseSuccess: true,
  };
}

module.exports = {
  decodeAmmV4,
  parseRaydiumAmmV4,
};
