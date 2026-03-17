const crypto = require("crypto");
const { PublicKey } = require("@solana/web3.js");
const { getSolUsdPrice } = require("../database");

// Known token mints
// Wrapped SOL (native SOL used in token program) — 44-character base58 address
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Stablecoins pegged ~$1 — used to determine if quote token is a stablecoin
const STABLECOIN_MINTS = new Set([
  USDC_MINT,
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX",  // USDH
]);

// ── Buffer reading helpers ──

function readPublicKey(buffer, offset) {
  return new PublicKey(buffer.slice(offset, offset + 32)).toBase58();
}

function readU8(buffer, offset) {
  return buffer.readUInt8(offset);
}

function readU16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function readI32(buffer, offset) {
  return buffer.readInt32LE(offset);
}

function readU64(buffer, offset) {
  return buffer.readBigUInt64LE(offset);
}

function readU128(buffer, offset) {
  const low = buffer.readBigUInt64LE(offset);
  const high = buffer.readBigUInt64LE(offset + 8);
  return low + (high << 64n);
}

function readI64(buffer, offset) {
  return buffer.readBigInt64LE(offset);
}

// ── Anchor discriminator ──

function computeDiscriminator(signature) {
  return crypto.createHash("sha256").update(signature).digest().slice(0, 8);
}

// ── Token balance extraction for swap detection ──

/**
 * Extract swap amounts from pre/post token balances.
 * Works for all DEX types — looks for the largest balance changes
 * matching the pool's base/quote mints.
 *
 * @param {object} txData - Full transaction data from getTransaction
 * @param {string} baseMint - Base token mint address (SOL for SOL/USDC pools)
 * @param {string} quoteMint - Quote token mint address (USDC for SOL/USDC pools)
 * @returns {{ side, baseAmount, quoteAmount, usdValue, traderWallet } | null}
 */
function extractSwapFromBalances(txData, baseMint, quoteMint) {
  if (!txData?.meta) return null;

  const preBalances = txData.meta.preTokenBalances || [];
  const postBalances = txData.meta.postTokenBalances || [];

  let baseChange = 0;
  let quoteChange = 0;
  let foundBaseChange = false;
  let foundQuoteChange = false;

  for (const post of postBalances) {
    const pre = preBalances.find((p) => p.accountIndex === post.accountIndex);
    if (!pre) continue;

    const postAmt = parseFloat(post.uiTokenAmount?.uiAmountString || "0");
    const preAmt = parseFloat(pre.uiTokenAmount?.uiAmountString || "0");
    const change = postAmt - preAmt;

    if (Math.abs(change) < 1e-9) continue;

    if (post.mint === baseMint) {
      if (Math.abs(change) > Math.abs(baseChange)) {
        baseChange = change;
        foundBaseChange = true;
      }
    } else if (post.mint === quoteMint) {
      if (Math.abs(change) > Math.abs(quoteChange)) {
        quoteChange = change;
        foundQuoteChange = true;
      }
    }
  }

  if (!foundBaseChange && !foundQuoteChange) return null;
  if (Math.abs(baseChange) < 0.0001 && Math.abs(quoteChange) < 0.01) return null;

  // Pool vault gained base = someone sold base = SELL
  // Pool vault lost base = someone bought base = BUY
  const traderBought = baseChange < 0;
  const baseAmount = Math.abs(baseChange);
  const quoteAmount = Math.abs(quoteChange);

  // USD value depends on quote token type:
  // - If quote is a stablecoin (USDC/USDT), quoteAmount ≈ USD directly
  // - If quote is SOL (e.g. USELESS/SOL pair), convert via SOL/USD price
  let usdValue;
  if (STABLECOIN_MINTS.has(quoteMint)) {
    usdValue = quoteAmount;
  } else if (quoteMint === SOL_MINT) {
    const solUsd = getSolUsdPrice();
    usdValue = solUsd > 0 ? quoteAmount * solUsd : 0;
  } else {
    usdValue = 0; // Unknown quote token — can't determine USD value
  }

  let traderWallet = null;
  try {
    const accountKeys = txData.transaction?.message?.accountKeys;
    if (accountKeys && accountKeys.length > 0) {
      const firstKey = accountKeys[0];
      traderWallet = typeof firstKey === "string" ? firstKey : firstKey?.pubkey || null;
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

// ── Event classification (shared) ──

/**
 * Classify a transaction into event types with severity.
 *
 * Event types:
 *  - new_pool:        Pool initialization (high)
 *  - whale:           Swap > $10K (high)
 *  - large_trade:     Swap > $500 (medium)
 *  - liquidity_add:   LP deposit (medium)
 *  - liquidity_remove: LP withdrawal (medium)
 *  - accumulator:     Wallet with 3+ buys, no sells — potential smart money (medium)
 *  - dumper:          Wallet with 3+ sells, ≤1 buy — potential exit (medium)
 *  - repeat_trader:   Wallet seen 3+ times on this pool (low→medium)
 *  - swap:            Regular swap (low — not stored as event)
 *
 * @param {string} txType
 * @param {object|null} swapDetails
 * @param {object|null} walletHistory - from getWalletPoolHistory() if available
 */
function classifyEvent(txType, swapDetails, walletHistory) {
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
    const usd = swapDetails.usdValue || 0;

    // Size-based: whale > $10K, large > $500
    if (usd > 10000) {
      return { eventType: "whale", severity: "high" };
    }
    if (usd > 500) {
      return { eventType: "large_trade", severity: "medium" };
    }

    // Wallet behavior (needs history from DB)
    if (walletHistory && walletHistory.trade_count >= 3) {
      // Accumulator: 3+ buys, 0 sells — potential smart money accumulating
      if (walletHistory.buy_count >= 3 && walletHistory.sell_count === 0) {
        return { eventType: "accumulator", severity: "medium" };
      }
      // Dumper: 3+ sells, ≤1 buy — potential exit / distribution
      if (walletHistory.sell_count >= 3 && walletHistory.buy_count <= 1) {
        return { eventType: "dumper", severity: "medium" };
      }
      // Repeat trader: 3+ trades mixed — active market maker or bot
      return { eventType: "repeat_trader", severity: "low" };
    }

    return { eventType: "swap", severity: "low" };
  }
  return { eventType: null, severity: "low" };
}

function buildEventDescription(eventType, swapDetails, poolLabel, extra = {}) {
  const shortLabel = (poolLabel || "").replace(/ — .*/, "");
  const fmtUsd = (v) => v ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "$?";
  const fmtWallet = (w) => w ? `${w.slice(0, 4)}...${w.slice(-4)}` : "";

  switch (eventType) {
    case "whale": {
      const side = swapDetails?.side || "swap";
      return `Whale ${side}: ${fmtUsd(swapDetails?.usdValue)} on ${shortLabel}`;
    }
    case "large_trade": {
      const side = swapDetails?.side || "swap";
      return `Large ${side}: ${fmtUsd(swapDetails?.usdValue)} on ${shortLabel}`;
    }
    case "accumulator": {
      const wh = extra.walletHistory;
      const trades = wh ? `${wh.buy_count} buys` : "";
      const total = wh ? `, ${fmtUsd(wh.total_usd)} total` : "";
      return `Accumulator detected on ${shortLabel}: ${trades}${total}`;
    }
    case "dumper": {
      const wh = extra.walletHistory;
      const trades = wh ? `${wh.sell_count} sells` : "";
      const total = wh ? `, ${fmtUsd(wh.total_usd)} total` : "";
      return `Dumper detected on ${shortLabel}: ${trades}${total}`;
    }
    case "repeat_trader": {
      const wh = extra.walletHistory;
      const trades = wh ? `${wh.trade_count} trades` : "active";
      const total = wh ? `, ${fmtUsd(wh.total_usd)} vol` : "";
      return `Repeat trader on ${shortLabel}: ${trades}${total}`;
    }
    case "liquidity_add":
      return `Liquidity added to ${shortLabel}`;
    case "liquidity_remove":
      return `Liquidity removed from ${shortLabel}`;
    case "new_pool": {
      const pair = extra.pair || (poolLabel || "").match(/— (.+)$/)?.[1] || "";
      const creator = extra.creatorWallet ? ` by ${fmtWallet(extra.creatorWallet)}` : "";
      return `New pool created: ${shortLabel} (${pair})${creator}`;
    }
    default:
      return `${eventType} on ${shortLabel}`;
  }
}

module.exports = {
  SOL_MINT,
  USDC_MINT,
  STABLECOIN_MINTS,
  readPublicKey,
  readU8,
  readU16,
  readI32,
  readU64,
  readU128,
  readI64,
  computeDiscriminator,
  extractSwapFromBalances,
  classifyEvent,
  buildEventDescription,
};
