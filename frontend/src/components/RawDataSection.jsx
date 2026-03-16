import React, { useState, useEffect } from "react";

const DEX_COLORS = {
  Raydium: "#8b5cf6",
  Orca: "#06b6d4",
  Meteora: "#f59e0b",
};

function formatTime(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)} sec ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDuration(ms) {
  if (!ms) return "—";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function truncProgram(id) {
  if (!id) return "—";
  return `${id.slice(0, 6)}...${id.slice(-4)}`;
}

function PoolRow({ pool }) {
  const [expanded, setExpanded] = useState(false);

  // Strip DEX prefix from label for display (e.g. "Raydium AMM v4 — SOL/USDC" → "AMM v4 — SOL/USDC")
  const shortLabel = pool.poolType
    ? `${pool.poolType} — ${pool.label.split("—").pop()?.trim() || pool.label}`
    : pool.label;

  return (
    <>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "10px 12px",
          borderBottom: "1px solid #1a1a1a",
          cursor: "pointer",
          fontSize: 13,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "#ddd", fontWeight: 500 }}>{shortLabel}</div>
          <div style={{ color: "#555", fontSize: 11, fontFamily: "monospace", marginTop: 2 }}>
            Program: {truncProgram(pool.programId)}
          </div>
        </div>
        <div style={{ color: pool.lastUpdated ? "#aaa" : "#555", minWidth: 90, textAlign: "right" }}>
          {formatTime(pool.lastUpdated)}
        </div>
        <div style={{ color: "#aaa", fontFamily: "monospace", minWidth: 110, textAlign: "right" }}>
          slot {pool.slot?.toLocaleString() || "—"}
        </div>
        <div style={{ color: "#aaa", minWidth: 60, textAlign: "right" }}>
          {formatBytes(pool.dataSize)}
        </div>
      </div>
      {expanded && pool.dataPreview && (
        <div
          style={{
            padding: "8px 12px 12px",
            borderBottom: "1px solid #1a1a1a",
            background: "#0a0a0a",
          }}
        >
          <div style={{ color: "#555", fontSize: 10, marginBottom: 4, textTransform: "uppercase" }}>
            Data preview (first 200 chars)
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              color: "#666",
              wordBreak: "break-all",
              lineHeight: 1.4,
            }}
          >
            {pool.dataPreview}
          </div>
        </div>
      )}
    </>
  );
}

function SizeBar({ items }) {
  if (!items || items.length === 0) return null;
  const maxSize = Math.max(...items.map((i) => i.avgDataSize || 0));
  if (maxSize === 0) return null;

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ color: "#666", fontSize: 11, fontWeight: 600, textTransform: "uppercase", marginBottom: 8 }}>
        Data size comparison
      </div>
      {items.map((item) => {
        const pct = maxSize > 0 ? ((item.avgDataSize || 0) / maxSize) * 100 : 0;
        const color = DEX_COLORS[item.dex] || "#666";
        return (
          <div key={`${item.dex}-${item.poolType}`} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <div style={{ color: "#aaa", fontSize: 12, minWidth: 130, textAlign: "right" }}>
              {item.dex} {item.poolType}
            </div>
            <div style={{ flex: 1, background: "#1a1a1a", borderRadius: 3, height: 16, overflow: "hidden" }}>
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: color,
                  opacity: 0.7,
                  borderRadius: 3,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <div style={{ color: "#aaa", fontSize: 12, minWidth: 70, fontFamily: "monospace" }}>
              {formatBytes(item.avgDataSize)}
            </div>
          </div>
        );
      })}
      <div style={{ color: "#555", fontSize: 11, marginTop: 4 }}>
        (different sizes = different data structures per DEX)
      </div>
    </div>
  );
}

export default function RawDataSection({ dbStats, pools }) {
  const [rawData, setRawData] = useState({});
  const [comparison, setComparison] = useState([]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, []);

  async function fetchData() {
    try {
      const [latestRes, compareRes] = await Promise.all([
        fetch("/api/raw/latest"),
        fetch("/api/raw/compare"),
      ]);
      const latestData = await latestRes.json();
      const compareData = await compareRes.json();
      setRawData(latestData.pools || {});
      setComparison(compareData.comparison || []);
    } catch {}
  }

  const collectingSince = dbStats?.collectingSince;
  const collectingDuration = collectingSince ? formatDuration(Date.now() - collectingSince) : "—";
  const totalSnapshots = dbStats?.rawAccountData || 0;

  const dexNames = Object.keys(rawData);
  const dexCount = dexNames.length;
  const poolCount = dexNames.reduce((sum, dex) => sum + rawData[dex].length, 0);

  return (
    <div>
      {/* Header */}
      <div style={{ color: "#888", fontSize: 13, marginBottom: 16 }}>
        Monitored Pools ({poolCount} pools across {dexCount} DEXes)
      </div>

      {/* DEX groups */}
      {dexNames.length > 0 ? (
        dexNames.map((dex) => (
          <div key={dex} style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: DEX_COLORS[dex] || "#888",
                textTransform: "uppercase",
                letterSpacing: 1,
                marginBottom: 6,
                paddingLeft: 2,
              }}
            >
              {dex}
            </div>
            <div
              style={{
                background: "#0d0d0d",
                border: "1px solid #1a1a1a",
                borderRadius: 6,
                overflow: "hidden",
              }}
            >
              {rawData[dex].map((pool) => (
                <PoolRow key={pool.address} pool={pool} />
              ))}
            </div>
          </div>
        ))
      ) : (
        // Show config pools while waiting for DB data
        pools && pools.length > 0 ? (
          <div style={{ color: "#555", fontSize: 13, padding: "12px 0" }}>
            Collecting data for {pools.length} pools... First results appear after ~{pools.length * 5} seconds.
          </div>
        ) : (
          <div style={{ color: "#555", fontSize: 13, padding: "12px 0" }}>
            Waiting for pool data...
          </div>
        )
      )}

      {/* Size comparison bar chart */}
      <SizeBar items={comparison} />

      {/* Stats bar */}
      <div
        style={{
          display: "flex",
          gap: 24,
          padding: "14px 0",
          borderTop: "1px solid #222",
          marginTop: 16,
          fontSize: 13,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div>
          <span style={{ color: "#666" }}>Total collected: </span>
          <span style={{ color: "#aaa", fontWeight: 600 }}>
            {totalSnapshots.toLocaleString()} snapshots
          </span>
          <span style={{ color: "#555" }}> over {collectingDuration}</span>
        </div>
        <div>
          <span style={{ color: "#666" }}>Database size: </span>
          <span style={{ color: "#aaa", fontWeight: 600 }}>
            {dbStats?.dbSizeMB || 0} MB
          </span>
        </div>
        <div>
          <span style={{ color: "#666" }}>Health checks: </span>
          <span style={{ color: "#aaa" }}>
            {(dbStats?.healthChecks || 0).toLocaleString()}
          </span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <a
            href="/api/db/download"
            style={{
              padding: "4px 12px",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 4,
              color: "#aaa",
              fontSize: 12,
              textDecoration: "none",
              cursor: "pointer",
            }}
          >
            Export SQLite DB
          </a>
        </div>
      </div>
    </div>
  );
}
