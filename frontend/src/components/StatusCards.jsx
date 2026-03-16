import React from "react";

const STATUS_COLORS = {
  healthy: "#22c55e",
  slow: "#eab308",
  down: "#ef4444",
};

function getStatus(stats) {
  if (!stats) return { label: "INIT", color: "#666" };
  if (!stats.isHealthy) return { label: "DOWN", color: STATUS_COLORS.down };
  if (stats.avgLatency > 1000) return { label: "SLOW", color: STATUS_COLORS.slow };
  return { label: "OK", color: STATUS_COLORS.healthy };
}

function StatusCard({ endpoint, isPrimary }) {
  const { stats } = endpoint;
  const status = getStatus(stats);

  return (
    <div
      style={{
        background: "#111",
        border: `1px solid ${isPrimary ? "#22c55e" : "#222"}`,
        borderRadius: 8,
        padding: "16px 20px",
        minWidth: 180,
        flex: "1 1 0",
        boxShadow: isPrimary ? "0 0 12px rgba(34,197,94,0.15)" : "none",
      }}
    >
      <div style={{ fontSize: 13, color: "#888", marginBottom: 4 }}>{endpoint.name}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: status.color,
            display: "inline-block",
            boxShadow: `0 0 6px ${status.color}`,
          }}
        />
        <span style={{ fontSize: 16, fontWeight: 600, color: status.color }}>{status.label}</span>
      </div>
      <div style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>
        {stats?.avgLatency ?? "—"}
        <span style={{ fontSize: 13, color: "#888", fontWeight: 400 }}>ms</span>
      </div>
      <div style={{ fontSize: 13, color: "#aaa", marginBottom: 8 }}>
        {stats?.successRate ?? "—"}% success
      </div>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          color: isPrimary ? "#22c55e" : "#555",
          letterSpacing: 1,
        }}
      >
        {isPrimary ? "PRIMARY" : "backup"}
      </div>
      {stats && stats.slotDrift > 0 && (
        <div style={{ fontSize: 11, color: "#eab308", marginTop: 4 }}>
          slot drift: {stats.slotDrift}
        </div>
      )}
    </div>
  );
}

export default function StatusCards({ endpoints, currentPrimary }) {
  if (!endpoints || endpoints.length === 0) {
    return <div style={{ color: "#666", padding: 20 }}>Waiting for data...</div>;
  }

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {endpoints.map((ep) => (
        <StatusCard key={ep.name} endpoint={ep} isPrimary={ep.name === currentPrimary} />
      ))}
    </div>
  );
}
