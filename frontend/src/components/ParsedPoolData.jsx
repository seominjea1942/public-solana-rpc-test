import React, { useState, useEffect, useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

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

function PriceChange({ label, value }) {
  if (value == null) return null;
  const color = value > 0 ? "#22c55e" : value < 0 ? "#ef4444" : "#666";
  const sign = value > 0 ? "+" : "";
  return (
    <div style={{ textAlign: "center", minWidth: 60 }}>
      <div style={{ color: "#555", fontSize: 10, textTransform: "uppercase", marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ color, fontSize: 13, fontWeight: 600 }}>
        {sign}{value.toFixed(2)}%
      </div>
    </div>
  );
}

function StatRow({ label, value, mono }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px solid #1a1a1a" }}>
      <span style={{ color: "#666", fontSize: 12 }}>{label}</span>
      <span style={{ color: "#aaa", fontSize: 12, fontFamily: mono ? "monospace" : "inherit" }}>{value}</span>
    </div>
  );
}

export default function ParsedPoolData({ parsedPool }) {
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
            SOL/USDC Price
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
              <Tooltip
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
            Pool Reserves
          </div>
          <StatRow label="Base (SOL)" value={formatAmount(pool.baseAmount, 4)} mono />
          <StatRow label="Quote (USDC)" value={formatAmount(pool.quoteAmount, 2)} mono />
          <StatRow label="Liquidity" value={formatUsd(pool.liquidityUsd)} mono />
          <StatRow label="Fee Rate" value={pool.feeRate != null ? `${(pool.feeRate * 100).toFixed(2)}%` : "—"} />
          <StatRow label="Status" value={pool.status ?? "—"} />
        </div>

        {/* Addresses */}
        <div style={{ background: "#0d0d0d", border: "1px solid #1a1a1a", borderRadius: 6, padding: 12 }}>
          <div style={{ color: "#8b5cf6", fontSize: 11, fontWeight: 700, textTransform: "uppercase", marginBottom: 8 }}>
            Pool Accounts
          </div>
          <StatRow label="Base Mint" value={truncAddr(pool.baseMint)} mono />
          <StatRow label="Quote Mint" value={truncAddr(pool.quoteMint)} mono />
          <StatRow label="LP Mint" value={truncAddr(pool.lpMint)} mono />
          <StatRow label="Base Vault" value={truncAddr(pool.baseVault)} mono />
          <StatRow label="Quote Vault" value={truncAddr(pool.quoteVault)} mono />
          <StatRow label="Market ID" value={truncAddr(pool.marketId)} mono />
        </div>
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
          Last parsed: <span style={{ color: "#aaa" }}>{formatTime(pool.timestamp)}</span>
        </span>
        <span>
          Slot: <span style={{ color: "#aaa", fontFamily: "monospace" }}>{pool.slot?.toLocaleString() || "—"}</span>
        </span>
        {pool.parseStats && (
          <>
            <span>
              Parses: <span style={{ color: "#aaa" }}>{pool.parseStats.total}</span>
              {" "}({pool.parseStats.successRate}% success)
            </span>
          </>
        )}
      </div>
    </div>
  );
}
