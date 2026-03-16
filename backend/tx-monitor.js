const { rateLimitedRpcPost } = require("./rate-limiter");
const { writePoolTransaction, getKnownSignatures } = require("./database");

/**
 * Part B — Transaction Monitor
 *
 * For a given pool:
 *  1. getSignaturesForAddress (1 RPC call) — latest 10 signatures
 *  2. Filter out already-seen signatures (via DB lookup)
 *  3. getTransaction for each new signature (~0-10 RPC calls)
 *  4. Classify tx type (swap/add/remove/other) for AMM v4, "unparsed" for others
 *  5. Store metadata in pool_transactions table
 *
 * @param {object} pool - Pool object from config (address, label, dex, poolType)
 * @param {string} rpcUrl - Primary RPC endpoint URL
 * @returns {{ success, rpcCalls, newTxCount, totalSignatures, durationMs, error? }}
 */
async function runTxMonitor(pool, rpcUrl) {
  const start = Date.now();
  let rpcCalls = 0;
  let newTxCount = 0;

  // 1. Get recent signatures for this pool address
  const sigResult = await rateLimitedRpcPost(rpcUrl, "getSignaturesForAddress", [
    pool.address,
    { limit: 10 },
  ]);
  rpcCalls++;

  if (!sigResult.success || !Array.isArray(sigResult.data)) {
    return {
      success: false,
      error: sigResult.error || "Failed to fetch signatures",
      rpcCalls,
      newTxCount: 0,
      totalSignatures: 0,
      durationMs: Date.now() - start,
    };
  }

  const signatures = sigResult.data;

  // 2. Filter out already-known signatures
  let knownSigs;
  try {
    knownSigs = getKnownSignatures(
      pool.address,
      signatures.map((s) => s.signature)
    );
  } catch (err) {
    knownSigs = new Set();
  }

  const newSignatures = signatures.filter((s) => !knownSigs.has(s.signature));

  // 3. Fetch each new transaction
  for (const sig of newSignatures) {
    const txResult = await rateLimitedRpcPost(rpcUrl, "getTransaction", [
      sig.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    rpcCalls++;

    // 4. Classify transaction type
    const txType =
      pool.poolType === "AMM v4"
        ? classifyAmmV4Tx(txResult.data)
        : "unparsed";

    // 5. Store in DB
    try {
      writePoolTransaction({
        timestamp: Date.now(),
        poolAddress: pool.address,
        poolLabel: pool.label,
        dex: pool.dex,
        poolType: pool.poolType,
        signature: sig.signature,
        blockTime: sig.blockTime || null,
        slot: sig.slot || null,
        txType,
        fee: txResult.data?.meta?.fee || null,
        success: txResult.success ? 1 : 0,
        errorMessage: txResult.error || null,
      });
      if (txResult.success) newTxCount++;
    } catch (err) {
      // INSERT OR IGNORE handles duplicate signatures gracefully
      if (!err.message?.includes("UNIQUE constraint")) {
        console.error(`[TxMonitor] DB write error for ${sig.signature.slice(0, 12)}...:`, err.message);
      }
    }
  }

  return {
    success: true,
    rpcCalls,
    newTxCount,
    totalSignatures: signatures.length,
    durationMs: Date.now() - start,
  };
}

/**
 * Basic classification for Raydium AMM v4 transactions.
 * Checks log messages for swap/deposit/withdraw indicators.
 * Full instruction-level parsing can be added later.
 */
function classifyAmmV4Tx(txData) {
  if (!txData || !txData.meta) return "unparsed";
  if (txData.meta.err) return "failed";

  const logs = txData.meta.logMessages || [];
  for (const log of logs) {
    if (log.includes("ray_log") || log.includes("swap") || log.includes("Swap")) {
      return "swap";
    }
    if (log.includes("Deposit") || log.includes("deposit") || log.includes("AddLiquidity")) {
      return "add_liquidity";
    }
    if (log.includes("Withdraw") || log.includes("withdraw") || log.includes("RemoveLiquidity")) {
      return "remove_liquidity";
    }
  }

  return "other";
}

module.exports = { runTxMonitor };
