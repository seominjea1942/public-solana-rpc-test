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

export default function ParsedPoolData({ parsedPool, validation }) {
  const [history, setHistory] = useState([]);
  const [selectedRange, setSelectedRange] = useState(1); // 1h default

  const pool = parsedPool;
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

  if (!pool || pool.error) {
    return (
      <div style={{ color: "#555", fontSize: 13, padding: "12px 0" }}>
        Waiting for first Raydium AMM v4 parse... (every ~20s when AMM v4 rotation comes up)
      </div>
    );
  }

  const pc = pool.priceChanges || {};

  return (
    <div>
      {/* Price header */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16 }}>
        <div>
          <div style={{ color: "#555", fontSize: 11, textTransform: "uppercase", marginBottom: 2 }}>
            <InfoTip text="The current price of 1 SOL in USDC, calculated directly from pool reserves (Quote USDC / Base SOL). This is the on-chain DEX price, which may differ slightly from centralized exchange prices.">
              SOL/USDC Price
            </InfoTip>
          </div>
          <div style={{ color: "#fff", fontSize: 28, fontWeight: 700, fontFamily: "monospace" }}>
            ${pool.price?.toFixed(4) || "—"}
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
                  background: selectedRange === i ? "#8b5cf6" : "#1a1a1a",
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
                stroke="#8b5cf6"
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
          <div style={{ color: "#8b5cf6", fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
            <InfoTip text="The actual token balances held inside this AMM liquidity pool. These reserves determine the exchange rate: when you swap, tokens move in/out of these reserves. The ratio of Base to Quote sets the price." noUnderline>
              Pool Reserves
            </InfoTip>
          </div>
          <StatRow
            label="Base (SOL)"
            value={formatAmount(pool.baseAmount, 4)}
            mono
            hint="The amount of SOL tokens currently held in this pool's reserve vault. When someone buys SOL, this decreases; when someone sells SOL, this increases."
          />
          <StatRow
            label="Quote (USDC)"
            value={formatAmount(pool.quoteAmount, 2)}
            mono
            hint="The amount of USDC (a US dollar stablecoin) held in this pool's reserve vault. This is the other side of the trading pair. Price is calculated as Quote / Base."
          />
          <StatRow
            label="Liquidity"
            value={formatUsd(pool.liquidityUsd)}
            mono
            hint="Total Value Locked (TVL) — the combined USD value of both tokens in the pool. Higher liquidity means less price impact (slippage) when trading. Calculated as 2 x Quote amount."
          />
          <StatRow
            label="Fee Rate"
            value={pool.feeRate != null ? `${(pool.feeRate * 100).toFixed(2)}%` : "—"}
            hint="The percentage fee charged on every swap through this pool. This fee is distributed to liquidity providers (LPs) as reward for providing their tokens to the pool."
          />
          <StatRow
            label="Status"
            value={pool.status ?? "—"}
            hint="The pool's on-chain status flag. Status 6 means the pool is active and fully operational. Other values may indicate the pool is paused, disabled, or in a special state."
          />
        </div>

        {/* Addresses */}
        <div style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 6, padding: 12 }}>
          <div style={{ color: "#8b5cf6", fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
            <InfoTip text="On-chain Solana addresses that make up this pool. Each pool has token 'mints' (the token type definitions), 'vaults' (the accounts holding actual tokens), and a linked order book market." noUnderline>
              Pool Accounts
            </InfoTip>
          </div>
          <StatRow
            label="Base Mint"
            value={truncAddr(pool.baseMint)}
            mono
            hint="The token contract address (mint) for the base token (SOL). On Solana, every token type has a unique 'mint' address that identifies it. This is like the token's ID card."
          />
          <StatRow
            label="Quote Mint"
            value={truncAddr(pool.quoteMint)}
            mono
            hint="The token contract address (mint) for the quote token (USDC). The quote token is what the base token is priced in — similar to how stocks are priced in USD."
          />
          <StatRow
            label="LP Mint"
            value={truncAddr(pool.lpMint)}
            mono
            hint="The mint address for LP (Liquidity Provider) tokens. When you deposit tokens into the pool, you receive LP tokens as a receipt. They represent your share of the pool."
          />
          <StatRow
            label="Base Vault"
            value={truncAddr(pool.baseVault)}
            mono
            hint="The on-chain token account that physically holds the pool's SOL reserves. We query this vault's balance to know exactly how much SOL the pool contains right now."
          />
          <StatRow
            label="Quote Vault"
            value={truncAddr(pool.quoteVault)}
            mono
            hint="The on-chain token account that physically holds the pool's USDC reserves. We query this vault's balance along with the base vault to calculate the current price."
          />
          <StatRow
            label="Market ID"
            value={truncAddr(pool.marketId)}
            mono
            hint="The OpenBook (formerly Serum) order book market linked to this AMM. Raydium AMM v4 pairs with an on-chain order book for additional liquidity and tighter spreads."
          />
        </div>
      </div>

      {/* Price Validation */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ color: "#8b5cf6", fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
          <InfoTip text="Automated price check: every 5 minutes, our parsed on-chain price is compared against DexScreener's API. This validates that our binary data parsing is correct. A small difference (< 0.5%) is expected due to timing — prices move between our fetch and DexScreener's report." noUnderline>
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
          <InfoTip text="When this pool data was last decoded from its raw on-chain account data. The parser runs every ~20 seconds when the AMM v4 pool comes up in the rotation cycle.">Last parsed</InfoTip>:{" "}
          <span style={{ color: "#aaa" }}>{formatTime(pool.timestamp)}</span>
        </span>
        <span>
          <InfoTip text="The Solana blockchain slot number when this data was read. Solana produces ~2.5 slots/sec. Slots are like block numbers — they tell you exactly which point in time the data comes from.">Slot</InfoTip>:{" "}
          <span style={{ color: "#aaa", fontFamily: "monospace" }}>{pool.slot?.toLocaleString() || "—"}</span>
        </span>
        {pool.parseStats && (
          <>
            <span>
              <InfoTip text="How many times we've successfully decoded the raw pool data. Parse failures can happen if the account data format is unexpected or an RPC call fails. A high success rate means the data pipeline is healthy.">Parses</InfoTip>:{" "}
              <span style={{ color: "#aaa" }}>{pool.parseStats.total}</span>
              {" "}({pool.parseStats.successRate}% success)
            </span>
          </>
        )}
      </div>
    </div>
  );
}
