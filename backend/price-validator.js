const { writePriceValidation, getLatestValidations } = require("./database");

/**
 * Fetch price from DexScreener (free, no auth needed).
 * Uses the token mint address to find the best pair.
 *
 * Rate limit: 300 req/min — we use ~0.8 req/min (4 pools x 1 per 5 min)
 */
async function getDexScreenerPrice(tokenAddress) {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`
    );
    if (!response.ok) {
      return null;
    }
    const data = await response.json();

    if (!data.pairs || data.pairs.length === 0) return null;

    // Get the pair with highest liquidity
    const bestPair = data.pairs.sort(
      (a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
    )[0];

    return {
      price: parseFloat(bestPair.priceUsd),
      dex: bestPair.dexId,
      pairAddress: bestPair.pairAddress,
      volume24h: bestPair.volume?.h24 || 0,
      liquidity: bestPair.liquidity?.usd || 0,
    };
  } catch (err) {
    console.error("[Validation] DexScreener fetch failed:", err.message);
    return null;
  }
}

/**
 * Validate our parsed price against DexScreener.
 *
 * Thresholds:
 *   < 0.5%  PASS    — Parser is working correctly
 *   0.5-2%  WARNING — Possible timing difference or minor parsing issue
 *   > 2%    FAIL    — Parser is likely broken, needs investigation
 */
async function validateParsedPrice(pool, parsedPrice) {
  // Use SOL mint (base token) to look up on DexScreener
  const baseMint = pool.baseMint;
  if (!baseMint || !parsedPrice || parsedPrice <= 0) return;

  const dexScreener = await getDexScreenerPrice(baseMint);

  if (!dexScreener || !dexScreener.price || dexScreener.price <= 0) {
    try {
      writePriceValidation({
        timestamp: Date.now(),
        poolAddress: pool.address || pool.poolAddress,
        dex: pool.dex || "Raydium",
        poolType: pool.poolType || "AMM v4",
        ourPrice: parsedPrice,
        referencePrice: null,
        differencePct: null,
        status: "skip",
        referenceSource: "dexscreener",
        referenceDex: null,
        detail: "DexScreener fetch failed or no price",
      });
    } catch {}
    return;
  }

  const diff =
    (Math.abs(parsedPrice - dexScreener.price) / dexScreener.price) * 100;

  let status;
  if (diff < 0.5) status = "pass";
  else if (diff < 2.0) status = "warning";
  else status = "fail";

  try {
    writePriceValidation({
      timestamp: Date.now(),
      poolAddress: pool.address || pool.poolAddress,
      dex: pool.dex || "Raydium",
      poolType: pool.poolType || "AMM v4",
      ourPrice: parsedPrice,
      referencePrice: dexScreener.price,
      differencePct: Math.round(diff * 1000) / 1000,
      status,
      referenceSource: "dexscreener",
      referenceDex: dexScreener.dex,
      detail:
        diff >= 2.0
          ? `Large deviation: ours $${parsedPrice.toFixed(4)} vs DexScreener $${dexScreener.price.toFixed(4)}`
          : null,
    });
  } catch (err) {
    console.error("[Validation] DB write error:", err.message);
  }

  if (status === "fail") {
    console.warn(
      `[Validation] FAIL: ${pool.label || pool.poolLabel} — Ours: $${parsedPrice.toFixed(4)}, ` +
        `DexScreener: $${dexScreener.price.toFixed(4)}, Diff: ${diff.toFixed(2)}%`
    );
  } else if (status === "warning") {
    console.warn(
      `[Validation] WARNING: ${pool.label || pool.poolLabel} — Diff: ${diff.toFixed(2)}%`
    );
  }
}

// ── Rate-limited validation (once per pool per 5 min) ──

const lastValidation = {};

async function maybeValidate(pool, parsedPrice) {
  const key = pool.address || pool.poolAddress;
  const now = Date.now();

  if (lastValidation[key] && now - lastValidation[key] < 5 * 60 * 1000) {
    return; // skip, validated recently
  }

  lastValidation[key] = now;
  await validateParsedPrice(pool, parsedPrice);
}

module.exports = { getDexScreenerPrice, validateParsedPrice, maybeValidate };
