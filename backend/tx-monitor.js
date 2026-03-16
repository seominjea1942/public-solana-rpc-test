const { rateLimitedRpcPost } = require("./rate-limiter");
const { writePoolTransaction, writeDefiEvent, getKnownSignatures, getPoolMints } = require("./database");

const RAYDIUM_AMM_V4_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

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
  const sigLimit = pool.poolType === "AMM v4" ? 5 : 3;
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

  // Get pool mints for swap detail extraction (AMM v4 only)
  let poolMints = null;
  if (pool.poolType === "AMM v4") {
    try {
      poolMints = getPoolMints(pool.address);
    } catch {}
  }

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

    // 4. Classify transaction type
    const txData = txResult.data;
    let txType = "unparsed";
    let swapDetails = null;
    let event = { eventType: null, severity: "low" };

    if (pool.poolType === "AMM v4") {
      // First try log-based classification
      txType = classifyAmmV4Tx(txData);

      // If log-based says "other", try detecting by token balance changes
      // Many swaps go through aggregators (Jupiter etc.) whose logs don't say "swap"
      if (poolMints && (txType === "other" || txType === "swap")) {
        swapDetails = extractSwapDetails(txData, poolMints);
        if (swapDetails && swapDetails.usdValue > 0.01) {
          txType = "swap"; // Confirmed swap via balance changes
        } else if (txType === "other") {
          // No meaningful balance changes — it's a crank/bot/observation
          txType = "other";
        }
      } else if (txType === "swap" && poolMints) {
        swapDetails = extractSwapDetails(txData, poolMints);
      }

      // Classify event
      event = classifyEvent(txType, swapDetails);

      // Record notable events
      if (event.severity !== "low" && event.eventType) {
        try {
          const desc = buildEventDescription(event.eventType, swapDetails, pool.label);
          writeDefiEvent({
            timestamp: sig.blockTime ? sig.blockTime * 1000 : Date.now(),
            poolAddress: pool.address,
            poolLabel: pool.label,
            dex: pool.dex,
            eventType: event.eventType,
            severity: event.severity,
            signature: sig.signature,
            traderWallet: swapDetails?.traderWallet || null,
            usdValue: swapDetails?.usdValue || null,
            description: desc,
          });
        } catch {}
      }
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
        traderWallet: swapDetails?.traderWallet || null,
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
 * Classify Raydium AMM v4 transaction type from log messages.
 * Checks log messages for swap/deposit/withdraw indicators.
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
    if (log.includes("Initialize") || log.includes("initialize")) {
      return "initialize";
    }
  }

  return "other";
}

/**
 * Extract swap amounts from pre/post token balances.
 * Looks for balance changes matching the pool's base/quote mints.
 *
 * Strategy: Sum ALL balance changes per mint across all accounts.
 * For a swap, the pool vaults will show opposite changes (one increases, one decreases).
 * We look at the net change from the pool's perspective.
 *
 * @param {object} txData - Full transaction data from getTransaction
 * @param {object} poolMints - { base_mint, quote_mint, base_vault, quote_vault } from parsed_pool_data
 * @returns {{ side, baseAmount, quoteAmount, usdValue, traderWallet } | null}
 */
function extractSwapDetails(txData, poolMints) {
  if (!txData?.meta) return null;

  const preBalances = txData.meta.preTokenBalances || [];
  const postBalances = txData.meta.postTokenBalances || [];

  // Track changes per account index for base and quote mints
  let baseChange = 0;
  let quoteChange = 0;
  let foundBaseChange = false;
  let foundQuoteChange = false;

  for (const post of postBalances) {
    const pre = preBalances.find(
      (p) => p.accountIndex === post.accountIndex
    );
    if (!pre) continue;

    const postAmt = parseFloat(post.uiTokenAmount?.uiAmountString || "0");
    const preAmt = parseFloat(pre.uiTokenAmount?.uiAmountString || "0");
    const change = postAmt - preAmt;

    if (Math.abs(change) < 1e-9) continue;

    if (post.mint === poolMints.base_mint) {
      // Sum up all base mint changes — look at the largest absolute change
      // which is likely the pool vault
      if (Math.abs(change) > Math.abs(baseChange)) {
        baseChange = change;
        foundBaseChange = true;
      }
    } else if (post.mint === poolMints.quote_mint) {
      if (Math.abs(change) > Math.abs(quoteChange)) {
        quoteChange = change;
        foundQuoteChange = true;
      }
    }
  }

  // Need at least one meaningful change
  if (!foundBaseChange && !foundQuoteChange) return null;
  if (Math.abs(baseChange) < 0.0001 && Math.abs(quoteChange) < 0.01) return null;

  // Determine buy/sell from TRADER's perspective:
  // Pool received base (baseChange > 0 from pool view) = trader sold base = SELL
  // Pool lost base (baseChange < 0 from pool view) = trader bought base = BUY
  // We track the pool vault changes, so baseChange > 0 means pool gained base
  const isBuy = baseChange > 0; // pool gained base = someone sold to pool = hmm...
  // Actually: if the largest base change is positive, pool vault gained SOL = someone sold SOL = SELL
  // If negative, pool vault lost SOL = someone bought SOL = BUY
  const traderBought = baseChange < 0;

  const baseAmount = Math.abs(baseChange);
  const quoteAmount = Math.abs(quoteChange);
  const usdValue = quoteAmount; // For SOL/USDC, quote = USDC ≈ USD

  // Find the trader wallet (fee payer / signer)
  let traderWallet = null;
  try {
    const accountKeys = txData.transaction?.message?.accountKeys;
    if (accountKeys && accountKeys.length > 0) {
      const firstKey = accountKeys[0];
      traderWallet = typeof firstKey === "string"
        ? firstKey
        : firstKey?.pubkey || null;
    }
  } catch {}

  return {
    side: traderBought ? "buy" : "sell",
    baseAmount: Math.round(baseAmount * 10000) / 10000,
    quoteAmount: Math.round(quoteAmount * 100) / 100,
    usdValue: Math.round(usdValue * 100) / 100,
    traderWallet,
  };
}

/**
 * Classify an event based on tx type and swap details.
 */
function classifyEvent(txType, swapDetails) {
  if (txType === "initialize") {
    return { eventType: "new_pool", severity: "high" };
  }

  if (txType === "add_liquidity") {
    return { eventType: "liquidity_add", severity: "medium" };
  }

  if (txType === "remove_liquidity") {
    return { eventType: "liquidity_remove", severity: "medium" };
  }

  if (txType === "swap" && swapDetails) {
    if (swapDetails.usdValue > 25000) {
      return { eventType: "whale", severity: "high" };
    }
    return { eventType: "swap", severity: "low" };
  }

  return { eventType: null, severity: "low" };
}

/**
 * Build a human-readable event description.
 */
function buildEventDescription(eventType, swapDetails, poolLabel) {
  const shortLabel = (poolLabel || "").replace(/ — .*/, "");
  switch (eventType) {
    case "whale": {
      const side = swapDetails?.side || "swap";
      const usd = swapDetails?.usdValue?.toLocaleString() || "?";
      return `Whale ${side}: $${usd} on ${shortLabel}`;
    }
    case "liquidity_add":
      return `Liquidity added to ${shortLabel}`;
    case "liquidity_remove":
      return `Liquidity removed from ${shortLabel}`;
    case "new_pool":
      return `New pool created: ${shortLabel}`;
    default:
      return `${eventType} on ${shortLabel}`;
  }
}

module.exports = { runTxMonitor };
