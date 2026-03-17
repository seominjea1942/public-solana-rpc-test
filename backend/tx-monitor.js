const { rateLimitedRpcPost } = require("./rate-limiter");
const { writePoolTransaction, writeDefiEvent, getKnownSignatures, getPoolMints, getFailedFetchSignatures, retryPoolTransaction, getWalletPoolHistory } = require("./database");
const { classifyTx } = require("./parsers");
const { extractSwapFromBalances, classifyEvent, buildEventDescription } = require("./parsers/utils");

/**
 * Part B — Transaction Monitor
 *
 * For a given pool:
 *  1. getSignaturesForAddress (1 RPC call) — latest 10 signatures
 *  2. Filter out already-seen signatures (via DB lookup)
 *  3. getTransaction for each new signature (~0-10 RPC calls)
 *  4. For AMM v4 swaps: extract amounts, side, USD value, trader wallet
 *  5. Classify events (whale, liquidity, etc.)
 *  6. Store transaction + events in SQLite
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
  // Use smaller limit to reduce RPC calls (each new sig = 1 getTransaction call)
  const sigLimit = 5;
  const sigResult = await rateLimitedRpcPost(rpcUrl, "getSignaturesForAddress", [
    pool.address,
    { limit: sigLimit },
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

  // Get pool mints for swap detail extraction (all pool types)
  let poolMints = null;
  try {
    poolMints = getPoolMints(pool.address);
  } catch {}

  // 3. Fetch each new transaction
  for (const sig of newSignatures) {
    const txResult = await rateLimitedRpcPost(rpcUrl, "getTransaction", [
      sig.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    rpcCalls++;

    if (!txResult.success) {
      // Still store the record but mark as failed
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
          txType: "fetch_error",
          success: 0,
          errorMessage: txResult.error || "Failed to fetch transaction",
        });
      } catch {}
      continue;
    }

    // 4. Classify transaction type (all DEX types)
    const txData = txResult.data;
    let txType = "unparsed";
    let swapDetails = null;
    let event = { eventType: null, severity: "low" };

    // Always extract fee payer (first account key) as the wallet
    let feePayer = null;
    try {
      const accountKeys = txData.transaction?.message?.accountKeys;
      if (accountKeys && accountKeys.length > 0) {
        const firstKey = accountKeys[0];
        feePayer = typeof firstKey === "string" ? firstKey : firstKey?.pubkey || null;
      }
    } catch {}

    // Use unified classifier for all pool types
    txType = classifyTx(pool.poolType, txData);

    // Extract swap details from token balance changes if we have pool mints
    if (poolMints && (txType === "other" || txType === "swap")) {
      swapDetails = extractSwapFromBalances(txData, poolMints.base_mint, poolMints.quote_mint);
      if (swapDetails && swapDetails.usdValue > 0.01) {
        txType = "swap"; // Confirmed swap via balance changes
      } else if (txType === "other") {
        txType = "other";
      }
    } else if (txType === "swap" && poolMints) {
      swapDetails = extractSwapFromBalances(txData, poolMints.base_mint, poolMints.quote_mint);
    }

    // Use fee payer as wallet when swap details don't provide one
    const traderWallet = swapDetails?.traderWallet || feePayer;

    // Look up wallet history for smart money detection (only for swaps with a known wallet)
    let walletHistory = null;
    if (traderWallet && txType === "swap") {
      try {
        walletHistory = getWalletPoolHistory(traderWallet, pool.address);
      } catch {}
    }

    // Classify event (pass wallet history for behavior-based detection)
    event = classifyEvent(txType, swapDetails, walletHistory);

    // Record notable events (low severity "repeat_trader" also gets stored now)
    const shouldStore = (event.severity !== "low" && event.eventType) ||
                        event.eventType === "repeat_trader";
    if (shouldStore) {
      try {
        const desc = buildEventDescription(event.eventType, swapDetails, pool.label, {
          signature: sig.signature,
          poolAddress: pool.address,
          creatorWallet: feePayer,
          pair: pool.label.match(/— (.+)$/)?.[1] || null,
          walletHistory,
        });
        writeDefiEvent({
          timestamp: sig.blockTime ? sig.blockTime * 1000 : Date.now(),
          poolAddress: pool.address,
          poolLabel: pool.label,
          dex: pool.dex,
          eventType: event.eventType,
          severity: event.severity,
          signature: sig.signature,
          traderWallet: traderWallet,
          usdValue: swapDetails?.usdValue || null,
          description: desc,
        });
      } catch {}
    }

    // 5. Store transaction
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
        side: swapDetails?.side || null,
        baseAmount: swapDetails?.baseAmount || null,
        quoteAmount: swapDetails?.quoteAmount || null,
        usdValue: swapDetails?.usdValue || null,
        traderWallet: traderWallet,
        fee: txData?.meta?.fee || null,
        eventType: event.eventType || null,
        eventSeverity: event.severity || null,
        success: 1,
        errorMessage: null,
      });
      newTxCount++;
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
 * Direct RPC fetch (bypasses main rate limiter).
 * Used for retry/backfill to avoid competing with the main pipeline.
 * Has its own built-in delay between calls.
 */
async function directRpcPost(url, method, params = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    const latency = Date.now() - start;
    if (res.status === 429) {
      return { latency, success: false, rateLimited: true, data: null, error: "429 Too Many Requests" };
    }

    const data = await res.json();
    if (data.error) {
      return { latency, success: false, rateLimited: false, data: null, error: data.error.message };
    }

    return { latency, success: true, rateLimited: false, data: data.result };
  } catch (err) {
    return { latency: Date.now() - start, success: false, rateLimited: false, data: null, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Retry previously-failed transaction fetches for a pool.
 *
 * Picks up to `maxRetries` oldest `fetch_error`/`unparsed` entries and re-fetches them.
 * Uses direct fetch (not the main rate limiter) with a secondary RPC endpoint,
 * so retries don't compete with the main health check / scheduler pipeline.
 *
 * Adds 3-second delays between calls to stay under rate limits.
 *
 * @param {object} pool - Pool object from config
 * @param {string} rpcUrl - RPC endpoint URL (should be a secondary/non-primary endpoint)
 * @param {number} maxRetries - Max retries per invocation (default: 2)
 * @returns {{ retriedCount, successCount, rpcCalls }}
 */
async function retryFailedTransactions(pool, rpcUrl, maxRetries = 2) {
  let retriedCount = 0;
  let successCount = 0;
  let rpcCalls = 0;

  const failedRows = getFailedFetchSignatures(pool.address, maxRetries);
  if (failedRows.length === 0) return { retriedCount, successCount, rpcCalls };

  let poolMints = null;
  try {
    poolMints = getPoolMints(pool.address);
  } catch {}

  for (const row of failedRows) {
    // 1.5-second delay between retry calls (using secondary endpoint, separate from main pipeline)
    if (retriedCount > 0) {
      await new Promise((r) => setTimeout(r, 1500));
    }

    const txResult = await directRpcPost(rpcUrl, "getTransaction", [
      row.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
    ]);
    rpcCalls++;
    retriedCount++;

    if (!txResult.success) {
      // Still failing — leave as-is, will be retried next cycle
      continue;
    }

    // Classify the transaction
    const txData = txResult.data;
    let txType = classifyTx(pool.poolType, txData);
    let swapDetails = null;
    let event = { eventType: null, severity: "low" };

    if (poolMints && (txType === "other" || txType === "swap")) {
      swapDetails = extractSwapFromBalances(txData, poolMints.base_mint, poolMints.quote_mint);
      if (swapDetails && swapDetails.usdValue > 0.01) {
        txType = "swap";
      }
    }

    // Extract fee payer for wallet info
    let feePayer = null;
    try {
      const acctKeys = txData.transaction?.message?.accountKeys;
      if (acctKeys && acctKeys.length > 0) {
        const k = acctKeys[0];
        feePayer = typeof k === "string" ? k : k?.pubkey || null;
      }
    } catch {}
    const wallet = swapDetails?.traderWallet || feePayer;

    // Wallet history for smart money detection
    let walletHistory = null;
    if (wallet && txType === "swap") {
      try { walletHistory = getWalletPoolHistory(wallet, pool.address); } catch {}
    }

    event = classifyEvent(txType, swapDetails, walletHistory);

    // Update the DB record
    try {
      retryPoolTransaction(row.id, txType, {
        side: swapDetails?.side || null,
        baseAmount: swapDetails?.baseAmount || null,
        quoteAmount: swapDetails?.quoteAmount || null,
        usdValue: swapDetails?.usdValue || null,
        traderWallet: wallet,
        fee: txData?.meta?.fee || null,
        eventType: event.eventType || null,
        eventSeverity: event.severity || null,
      });
      successCount++;
    } catch (err) {
      console.error(`[TxMonitor] Retry update error for ${row.signature.slice(0, 12)}...:`, err.message);
    }
  }

  if (successCount > 0) {
    console.log(`[TxMonitor] Retried ${retriedCount} for ${pool.label}: ${successCount} recovered`);
  }

  return { retriedCount, successCount, rpcCalls };
}

module.exports = { runTxMonitor, retryFailedTransactions };
