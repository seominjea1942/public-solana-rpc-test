/**
 * Unified Multi-DEX Parser Interface
 *
 * Maps pool types to their specific parser modules.
 * Each parser follows the same interface:
 *   - parseXxx(rpcUrl, base64Data, slot) → returns standardized parsed object
 *   - classifyXxxTx(txData) → returns tx type string
 *
 * The existing Raydium AMM v4 parser is in pool-parser.js (unchanged).
 */

const { parseRaydiumAmmV4 } = require("../pool-parser");
const { parseRaydiumCpmm, classifyCpmmTx } = require("./raydium-cpmm");
const { parseOrcaWhirlpool, classifyWhirlpoolTx } = require("./orca-whirlpool");
const { parseMeteoraDlmm, classifyMeteoraTx } = require("./meteora-dlmm");

/**
 * Parse pool state for any supported DEX type.
 *
 * @param {string} rpcUrl - RPC endpoint URL
 * @param {string} poolType - Pool type from config ("AMM v4", "CPMM", "Whirlpool", "DLMM")
 * @param {string} base64Data - Raw base64 account data
 * @param {number} slot - Slot at which data was fetched
 * @returns {object} Standardized parsed pool object (same fields for all DEX types)
 */
async function parsePoolState(rpcUrl, poolType, base64Data, slot) {
  switch (poolType) {
    case "AMM v4":
      return parseRaydiumAmmV4(rpcUrl, base64Data, slot);
    case "CPMM":
      return parseRaydiumCpmm(rpcUrl, base64Data, slot);
    case "Whirlpool":
      return parseOrcaWhirlpool(rpcUrl, base64Data, slot);
    case "DLMM":
      return parseMeteoraDlmm(rpcUrl, base64Data, slot);
    default:
      throw new Error(`No parser for pool type: ${poolType}`);
  }
}

/**
 * Classify a transaction for any supported DEX type.
 * Returns: "swap" | "add_liquidity" | "remove_liquidity" | "initialize" | "other" | "failed" | "unparsed"
 */
function classifyTx(poolType, txData) {
  switch (poolType) {
    case "AMM v4":
      return classifyAmmV4Tx(txData);
    case "CPMM":
      return classifyCpmmTx(txData);
    case "Whirlpool":
      return classifyWhirlpoolTx(txData);
    case "DLMM":
      return classifyMeteoraTx(txData);
    default:
      return "unparsed";
  }
}

/**
 * AMM v4 tx classification (previously in tx-monitor.js).
 * Kept here for the unified interface.
 */
const AMM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";

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

  // Fallback: aggregator transactions may truncate inner CPI logs.
  // Check if AMM v4 program is in account keys + token balance changes.
  const acctKeys = txData.transaction?.message?.accountKeys || [];
  const hasAmmKey = acctKeys.some(
    (k) => (k.pubkey || k) === AMM_V4_PROGRAM_ID
  );

  if (hasAmmKey) {
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

/**
 * Check if a pool type has a parser available.
 */
function hasParser(poolType) {
  return ["AMM v4", "CPMM", "Whirlpool", "DLMM"].includes(poolType);
}

module.exports = {
  parsePoolState,
  classifyTx,
  hasParser,
};
