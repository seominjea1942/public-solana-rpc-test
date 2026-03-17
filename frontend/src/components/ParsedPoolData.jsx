import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import InfoTip from "./Tooltip";

function truncAddr(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function formatUsd(val) {
  if (val == null) return "—";
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
  return `$${val.toFixed(2)}`;
}

function formatAmount(val, decimals) {
  if (val == null) return "—";
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`;
  return val.toFixed(decimals != null ? Math.min(decimals, 4) : 4);
}

function formatTime(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const TIME_RANGES = [
  { label: "30m", ms: 30 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "All", ms: 0 },
];

const PRICE_CHANGE_HINTS = {
  "5m": "Price change over the last 5 minutes. Useful for spotting very short-term volatility or sudden spikes.",
  "1h": "Price change over the last 1 hour. Shows short-term momentum and recent trading activity direction.",
  "6h": "Price change over the last 6 hours. Helps identify medium-term trends within the current trading session.",
  "24h": "Price change over the last 24 hours. The standard benchmark for daily performance, similar to what you see on CoinGecko or CoinMarketCap.",
};

const DEX_COLORS = {
  "Raydium": "#8b5cf6",
  "Orca": "#00d18c",
  "Meteora": "#f59e0b",
};

const DEX_TYPE_HINTS = {
  "AMM v4": "Raydium's classic constant-product AMM. Uses x*y=k formula with an OpenBook order book for extra liquidity.",
  "CPMM": "Raydium's Concentrated Product Market Maker. Similar to AMM v4 but without the linked order book.",
  "Whirlpool": "Orca's concentrated liquidity AMM (similar to Uniswap V3). Liquidity providers choose price ranges for capital efficiency.",
  "DLMM": "Meteora's Dynamic Liquidity Market Maker. Uses discrete bins instead of a continuous curve, enabling zero-slippage within each bin.",
};

function PriceChange({ label, value }) {
  if (value == null) return null;
  const color = value > 0 ? "#22c55e" : value < 0 ? "#ef4444" : "#666";
  const sign = value > 0 ? "+" : "";
  return (
    <div style={{ textAlign: "center", minWidth: 60 }}>
      <div style={{ color: "#555", fontSize: 10, textTransform: "uppercase", marginBottom: 2 }}>
        <InfoTip text={PRICE_CHANGE_HINTS[label] || `Price change over ${label}`}>{label}</InfoTip>
      </div>
      <div style={{ color, fontSize: 13, fontWeight: 600 }}>
        {sign}{value.toFixed(2)}%
      </div>
    </div>
  );
}

function StatRow({ label, value, mono, hint }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #1a1a1a", alignItems: "center" }}>
      <span style={{ color: "#666", fontSize: 12 }}>
        {hint ? <InfoTip text={hint}>{label}</InfoTip> : label}
      </span>
      <span style={{ color: "#aaa", fontSize: 12, fontFamily: mono ? "monospace" : "inherit" }}>{value}</span>
    </div>
  );
}

const STATUS_CONFIG = {
  pass: { icon: "\u2705", label: "PASS", color: "#22c55e", bg: "rgba(34, 197, 94, 0.08)" },
  warning: { icon: "\u26a0\ufe0f", label: "WARNING", color: "#eab308", bg: "rgba(234, 179, 8, 0.08)" },
  fail: { icon: "\u274c", label: "FAIL", color: "#ef4444", bg: "rgba(239, 68, 68, 0.08)" },
  skip: { icon: "\u23ed\ufe0f", label: "SKIP", color: "#666", bg: "transparent" },
};

function ValidationPanel({ validation, poolAddress }) {
  if (!validation) return null;

  const { validations, summary } = validation;
  if (!validations || validations.length === 0) {
    return (
      <div style={{ color: "#555", fontSize: 12, padding: "8px 0" }}>
        No price validations yet. First check runs ~5 min after parse starts.
      </div>
    );
  }

  // Find validation for the current pool, or show all
  const currentPool = poolAddress
    ? validations.find((v) => v.poolAddress === poolAddress)
    : null;

  return (
    <div>
      {/* Summary bar */}
      <div style={{
        display: "flex",
        gap: 16,
        padding: "8px 12px",
        background: "#0d0d0d",
        border: "1px solid #1a1a1a",
        borderRadius: 6,
        marginBottom: 12,
        flexWrap: "wrap",
        alignItems: "center",
        fontSize: 12,
      }}>
        <span style={{ color: "#666", fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
          <InfoTip text="Automated price verification: our parsed price vs DexScreener's reported price. Checks run every 5 minutes per pool. Pass = diff < 0.5%, Warning = 0.5-2%, Fail = > 2%">
            Parser Accuracy
          </InfoTip>
        </span>
        {validations.map((v) => {
          const cfg = STATUS_CONFIG[v.status] || STATUS_CONFIG.skip;
          const shortDex = (v.dex || "").replace("Raydium", "Ray").replace("Meteora", "Met");
          const poolType = v.poolType || "";
          return (
            <span key={v.poolAddress} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#888", fontSize: 11 }}>{shortDex} {poolType}</span>
              <span style={{ color: cfg.color, fontWeight: 600 }}>
                {cfg.icon} {v.differencePct != null ? `${v.differencePct.toFixed(2)}%` : cfg.label}
              </span>
            </span>
          );
        })}
        {summary && (
          <span style={{ color: "#555", marginLeft: "auto", fontSize: 11 }}>
            {summary.totalChecks} checks, {summary.accuracy}% pass
          </span>
        )}
      </div>

      {/* Detail card for current pool */}
      {currentPool && currentPool.status !== "skip" && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 1fr 1fr",
          gap: 12,
          padding: "10px 12px",
          background: STATUS_CONFIG[currentPool.status]?.bg || "transparent",
          border: `1px solid ${STATUS_CONFIG[currentPool.status]?.color || "#333"}22`,
          borderRadius: 6,
          marginBottom: 12,
          fontSize: 12,
        }}>
          <div>
            <div style={{ color: "#555", fontSize: 10, textTransform: "uppercase", marginBottom: 2 }}>
              <InfoTip text="The price we calculated by decoding the raw on-chain pool data (base64 account data -> vault balances -> quote/base ratio).">
                Our Price
              </InfoTip>
            </div>
            <div style={{ color: "#aaa", fontFamily: "monospace", fontWeight: 600 }}>
              ${currentPool.ourPrice?.toFixed(4) || "—"}
            </div>
          </div>
          <div>
            <div style={{ color: "#555", fontSize: 10, textTransform: "uppercase", marginBottom: 2 }}>
              <InfoTip text="The price reported by DexScreener's free API (dexscreener.com). This aggregates prices from multiple DEX sources and is widely used as a reference.">
                DexScreener
              </InfoTip>
            </div>
            <div style={{ color: "#aaa", fontFamily: "monospace", fontWeight: 600 }}>
              ${currentPool.referencePrice?.toFixed(4) || "—"}
            </div>
          </div>
          <div>
            <div style={{ color: "#555", fontSize: 10, textTransform: "uppercase", marginBottom: 2 }}>
              <InfoTip text="Absolute percentage difference between our parsed price and DexScreener's price. < 0.5% is normal (timing differences). > 2% suggests a parsing issue.">
                Diff
              </InfoTip>
            </div>
            <div style={{ color: STATUS_CONFIG[currentPool.status]?.color || "#aaa", fontFamily: "monospace", fontWeight: 600 }}>
              {currentPool.differencePct != null ? `${currentPool.differencePct.toFixed(3)}%` : "—"}
            </div>
          </div>
          <div>
            <div style={{ color: "#555", fontSize: 10, textTransform: "uppercase", marginBottom: 2 }}>
              Status
            </div>
            <div style={{ color: STATUS_CONFIG[currentPool.status]?.color || "#aaa", fontWeight: 700 }}>
              {STATUS_CONFIG[currentPool.status]?.icon} {STATUS_CONFIG[currentPool.status]?.label}
            </div>
          </div>
        </div>
      )}

      {/* Last validated time */}
      {currentPool && (
        <div style={{ fontSize: 11, color: "#555" }}>
          Last validated: <span style={{ color: "#888" }}>{formatTime(currentPool.lastChecked)}</span>
          {summary && (
            <span style={{ marginLeft: 16 }}>
              Accuracy (all time): <span style={{ color: "#888" }}>
                {summary.totalChecks} checks, {summary.passes} pass, {summary.warnings} warn, {summary.fails} fail
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Multi-pool price comparison bar ──
function PriceComparisonBar({ pools }) {
  if (!pools || pools.length === 0) return null;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${pools.length}, 1fr)`,
      gap: 8,
      marginBottom: 16,
    }}>
      {pools.map((p) => {
        const dexColor = DEX_COLORS[p.dex] || "#666";
        const pairName = p.poolLabel?.split(" — ")[1] || "";
        const priceStr = p.price > 0
          ? p.price >= 1 ? `$${p.price.toFixed(2)}` : `$${p.price.toFixed(4)}`
          : "—";

        return (
          <div
            key={p.poolAddress}
            style={{
              background: "#0a0a0a",
              border: `1px solid ${dexColor}33`,
              borderRadius: 6,
              padding: "10px 12px",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 10, color: dexColor, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>
              {p.dex} {p.poolType}
            </div>
            <div style={{ fontSize: 9, color: "#666", marginBottom: 2 }}>
              {pairName}
            </div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "monospace", color: p.price > 0 ? "#fff" : "#555" }}>
              {priceStr}
            </div>
            <div style={{ fontSize: 11, color: "#666", marginTop: 4 }}>
              <span style={{ color: "#555" }}>Liq: </span>
              <span style={{ color: "#888" }}>{formatUsd(p.liquidityUsd)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Pool detail card ──
function PoolDetailCard({ pool, validation }) {
  const [history, setHistory] = useState([]);
  const [selectedRange, setSelectedRange] = useState(1); // 1h default

  const poolAddress = pool?.poolAddress;

  useEffect(() => {
    if (!poolAddress) return;
    fetchHistory();
    const interval = setInterval(fetchHistory, 20000);
    return () => clearInterval(interval);
  }, [poolAddress, selectedRange]);

  async function fetchHistory() {
    if (!poolAddress) return;
    const range = TIME_RANGES[selectedRange];
    const hours = range.ms > 0 ? range.ms / 3600000 : 72;
    try {
      const res = await fetch(`/api/parsed/history?pool=${poolAddress}&hours=${hours}`);
      const data = await res.json();
      setHistory(data.entries || []);
    } catch {}
  }

  const chartData = useMemo(() => {
    return history.map((e) => ({
      time: e.timestamp,
      price: e.price,
      liquidity: e.liquidity_usd,
    }));
  }, [history]);

  if (!pool) return null;

  const pc = pool.priceChanges || {};
  const dexColor = DEX_COLORS[pool.dex] || "#8b5cf6";
  const poolTypeHint = DEX_TYPE_HINTS[pool.poolType] || "";

  // Extract pair name from pool label (e.g., "Raydium CPMM — USELESS/SOL" -> "USELESS/SOL")
  const pairName = pool.poolLabel?.split(" — ")[1] || "Token Price";
  const pairParts = pairName.split("/");
  const baseName = pairParts[0] || "Base";
  const quoteName = pairParts[1] || "Quote";
  const isUsdcPair = pairName.includes("USDC") || pairName.includes("USDT");
  const priceDecimals = pool.price >= 1 ? 4 : pool.price >= 0.001 ? 6 : 8;

  return (
    <div>
      {/* Price header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ color: "#555", fontSize: 11, textTransform: "uppercase", marginBottom: 2 }}>
            <InfoTip text={isUsdcPair
              ? "Price calculated directly from on-chain pool data. Each DEX uses a different price mechanism (AMM formula, sqrt price, or bin-based)."
              : `Price of 1 ${pairName.split("/")[0]} in USD, calculated from on-chain pool reserves and the current SOL/USD rate from other pools.`
            }>
              {pairName} Price {!isUsdcPair && <span style={{ fontSize: 9, color: "#666" }}>(USD)</span>}
            </InfoTip>
          </div>
          <div style={{ color: "#fff", fontSize: 28, fontWeight: 700, fontFamily: "monospace" }}>
            ${pool.price?.toFixed(priceDecimals) || "—"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 16, marginLeft: "auto" }}>
          <PriceChange label="5m" value={pc["5m"]} />
          <PriceChange label="1h" value={pc["1h"]} />
          <PriceChange label="6h" value={pc["6h"]} />
          <PriceChange label="24h" value={pc["24h"]} />
        </div>
      </div>

      {/* Price chart */}
      {chartData.length > 1 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", gap: 0, marginBottom: 12 }}>
            {TIME_RANGES.map((r, i) => (
              <button
                key={r.label}
                onClick={() => setSelectedRange(i)}
                style={{
                  padding: "4px 12px",
                  fontSize: 11,
                  fontWeight: 600,
                  border: "1px solid #333",
                  borderRight: i < TIME_RANGES.length - 1 ? "none" : "1px solid #333",
                  borderRadius:
                    i === 0
                      ? "5px 0 0 5px"
                      : i === TIME_RANGES.length - 1
                        ? "0 5px 5px 0"
                        : 0,
                  background: selectedRange === i ? dexColor : "#1a1a1a",
                  color: selectedRange === i ? "#fff" : "#888",
                  cursor: "pointer",
                }}
              >
                {r.label}
              </button>
            ))}
            <span style={{ marginLeft: 12, fontSize: 11, color: "#555", alignSelf: "center" }}>
              {chartData.length} points
            </span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis
                dataKey="time"
                tick={{ fill: "#666", fontSize: 10 }}
                tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                stroke="#333"
              />
              <YAxis
                tick={{ fill: "#666", fontSize: 10 }}
                stroke="#333"
                domain={["auto", "auto"]}
                tickFormatter={(v) => `$${v.toFixed(2)}`}
              />
              <RechartsTooltip
                contentStyle={{ background: "#1a1a1a", border: "1px solid #333", borderRadius: 6, fontSize: 12 }}
                labelFormatter={(t) => new Date(t).toLocaleString()}
                formatter={(value) => [`$${value.toFixed(4)}`, "Price"]}
              />
              <Line
                type="monotone"
                dataKey="price"
                stroke={dexColor}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Pool details grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        {/* Amounts */}
        <div style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 6, padding: 12 }}>
          <div style={{ color: dexColor, fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
            <InfoTip text="The actual token balances held inside this liquidity pool. These reserves determine the exchange rate." noUnderline>
              Pool Reserves
            </InfoTip>
          </div>
          <StatRow
            label={`Base (${baseName})`}
            value={formatAmount(pool.baseAmount, 4)}
            mono
            hint={`The amount of ${baseName} tokens currently held in this pool's reserve vault.`}
          />
          <StatRow
            label={`Quote (${quoteName})`}
            value={formatAmount(pool.quoteAmount, 2)}
            mono
            hint={`The amount of ${quoteName} held in this pool's reserve vault.`}
          />
          <StatRow
            label="Liquidity"
            value={formatUsd(pool.liquidityUsd)}
            mono
            hint="Total Value Locked (TVL) — the combined USD value of both tokens in the pool."
          />
          <StatRow
            label="Fee Rate"
            value={pool.feeRate != null ? `${(pool.feeRate * 100).toFixed(2)}%` : "—"}
            hint="The percentage fee charged on every swap through this pool."
          />
          <StatRow
            label="Status"
            value={pool.status ?? "—"}
            hint="The pool's on-chain status flag."
          />
          {pool.poolType === "Whirlpool" && pool.tickCurrentIndex != null && (
            <>
              <StatRow label="Tick Index" value={pool.tickCurrentIndex} mono hint="Current tick index in the Whirlpool's concentrated liquidity range." />
              <StatRow label="Tick Spacing" value={pool.tickSpacing ?? "—"} mono hint="Minimum tick spacing for this Whirlpool pool." />
            </>
          )}
          {pool.poolType === "DLMM" && pool.activeId != null && (
            <>
              <StatRow label="Active Bin" value={pool.activeId} mono hint="The currently active bin ID in the DLMM." />
              <StatRow label="Bin Step" value={pool.binStep ?? "—"} mono hint="Price step between adjacent bins (in basis points / 100)." />
            </>
          )}
        </div>

        {/* Addresses */}
        <div style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 6, padding: 12 }}>
          <div style={{ color: dexColor, fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
            <InfoTip text="On-chain Solana addresses that make up this pool." noUnderline>
              Pool Accounts
            </InfoTip>
          </div>
          <StatRow label="Base Mint" value={truncAddr(pool.baseMint)} mono hint={`Token contract address for the base token (${baseName}).`} />
          <StatRow label="Quote Mint" value={truncAddr(pool.quoteMint)} mono hint={`Token contract address for the quote token (${quoteName}).`} />
          {pool.lpMint && <StatRow label="LP Mint" value={truncAddr(pool.lpMint)} mono hint="Mint address for LP tokens issued to liquidity providers." />}
          <StatRow label="Base Vault" value={truncAddr(pool.baseVault)} mono hint={`Token account holding the pool's ${baseName} reserves.`} />
          <StatRow label="Quote Vault" value={truncAddr(pool.quoteVault)} mono hint={`Token account holding the pool's ${quoteName} reserves.`} />
          {pool.marketId && <StatRow label="Market ID" value={truncAddr(pool.marketId)} mono hint="OpenBook order book market linked to this AMM." />}
        </div>
      </div>

      {/* Price Validation */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: dexColor, fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
          <InfoTip text="Automated price check: every 5 minutes, our parsed on-chain price is compared against DexScreener's API." noUnderline>
            Price Validation
          </InfoTip>
        </div>
        <ValidationPanel validation={validation} poolAddress={pool?.poolAddress} />
      </div>

      {/* Parse stats footer */}
      <div
        style={{
          display: "flex",
          gap: 24,
          padding: "10px 0",
          borderTop: "1px solid #222",
          fontSize: 12,
          flexWrap: "wrap",
          color: "#666",
        }}
      >
        <span>
          <InfoTip text={`DEX type: ${poolTypeHint}`}>Type</InfoTip>:{" "}
          <span style={{ color: dexColor }}>{pool.dex} {pool.poolType}</span>
        </span>
        <span>
          Last parsed:{" "}
          <span style={{ color: "#aaa" }}>{formatTime(pool.timestamp)}</span>
        </span>
        <span>
          Slot:{" "}
          <span style={{ color: "#aaa", fontFamily: "monospace" }}>{pool.slot?.toLocaleString() || "—"}</span>
        </span>
        {pool.parseStats && (
          <span>
            Parses:{" "}
            <span style={{ color: "#aaa" }}>{pool.parseStats.total}</span>
            {" "}({pool.parseStats.successRate}% success)
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main component ──
export default function ParsedPoolData({ parsedPools, parsedPool, validation }) {
  const [selectedPoolIdx, setSelectedPoolIdx] = useState(0);

  // Use parsedPools if available, fall back to single parsedPool
  const pools = parsedPools && parsedPools.length > 0
    ? parsedPools
    : parsedPool ? [parsedPool] : [];

  const selectedPool = pools[selectedPoolIdx] || pools[0] || null;

  if (pools.length === 0) {
    return (
      <div style={{ color: "#555", fontSize: 13, padding: "12px 0" }}>
        Waiting for first pool parse... (scheduler starts ~10s after boot, then cycles every ~30s)
      </div>
    );
  }

  return (
    <div>
      {/* Price comparison bar - all pools at a glance */}
      <PriceComparisonBar pools={pools} />

      {/* Pool selector tabs */}
      {pools.length > 1 && (
        <div style={{ display: "flex", gap: 0, marginBottom: 16 }}>
          {pools.map((p, i) => {
            const dexColor = DEX_COLORS[p.dex] || "#666";
            const isSelected = i === selectedPoolIdx;
            return (
              <button
                key={p.poolAddress || i}
                onClick={() => setSelectedPoolIdx(i)}
                style={{
                  padding: "8px 16px",
                  fontSize: 12,
                  fontWeight: isSelected ? 700 : 500,
                  border: `1px solid ${isSelected ? dexColor : "#333"}`,
                  borderRight: i < pools.length - 1 ? "none" : undefined,
                  borderRadius:
                    i === 0
                      ? "6px 0 0 6px"
                      : i === pools.length - 1
                        ? "0 6px 6px 0"
                        : 0,
                  background: isSelected ? `${dexColor}22` : "#0d0d0d",
                  color: isSelected ? dexColor : "#666",
                  cursor: "pointer",
                  transition: "all 0.15s",
                }}
              >
                {p.dex} {p.poolType}
                {p.price > 0 && (
                  <span style={{ marginLeft: 8, fontFamily: "monospace", fontSize: 11 }}>
                    ${p.price.toFixed(2)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Selected pool detail */}
      <PoolDetailCard pool={selectedPool} validation={validation} />
    </div>
  );
}
