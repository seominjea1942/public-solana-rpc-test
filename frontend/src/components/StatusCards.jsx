import React, { useState, useRef, useEffect } from "react";
import Tooltip from "./Tooltip";

const STATUS_COLORS = {
  healthy: "#22c55e",
  slow: "#eab308",
  down: "#ef4444",
};

function getHttpStatus(stats) {
  if (!stats) return { label: "INIT", color: "#666" };
  if (!stats.isHealthy) return { label: "DOWN", color: STATUS_COLORS.down };
  if (stats.avgLatency > 500) return { label: "SLOW", color: STATUS_COLORS.slow };
  return { label: "OK", color: STATUS_COLORS.healthy };
}

function getWsStatus(wsData) {
  if (!wsData || !wsData.wsSupported) return { label: "N/A", color: "#444" };
  if (wsData.status === "connected") return { label: "OK", color: STATUS_COLORS.healthy };
  if (wsData.status === "connecting") return { label: "RECONNECTING", color: STATUS_COLORS.slow };
  return { label: "DOWN", color: STATUS_COLORS.down };
}

function formatDuration(ms) {
  if (!ms) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function getWsDetail(wsData) {
  if (!wsData || !wsData.wsSupported) return "not supported";
  if (wsData.status === "connected" && wsData.connectedAt) {
    return `connected ${formatDuration(Date.now() - wsData.connectedAt)}`;
  }
  if (wsData.status === "connecting") return "(reconnecting...)";
  if (wsData.lastMessageAt) {
    const ago = Math.floor((Date.now() - wsData.lastMessageAt) / 1000);
    return `(dropped ${ago}s ago)`;
  }
  return "(no connect)";
}

function ProviderInfoPanel({ endpoint }) {
  const [visible, setVisible] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);
  const [position, setPosition] = useState("below");

  useEffect(() => {
    if (visible && panelRef.current && buttonRef.current) {
      const btnRect = buttonRef.current.getBoundingClientRect();
      const panelHeight = 280;
      if (btnRect.bottom + panelHeight > window.innerHeight && btnRect.top > panelHeight) {
        setPosition("above");
      } else {
        setPosition("below");
      }
    }
  }, [visible]);

  const { info, description, details } = endpoint;
  // Build rows from info (preferred) or fallback to details
  const rows = [];
  if (info?.endpoint) rows.push({ label: "Endpoint", value: info.endpoint });
  if (info?.auth) rows.push({ label: "Auth", value: info.auth });
  else if (details) rows.push({ label: "Auth", value: details.authRequired ? "API key required" : "No API key needed" });
  if (info?.rateLimit) rows.push({ label: "Rate limit", value: info.rateLimit });
  else if (details?.rateLimit) rows.push({ label: "Rate limit", value: details.rateLimit });
  if (info?.notes) rows.push({ label: "Notes", value: info.notes });
  if (details?.bestFor) rows.push({ label: "Best for", value: details.bestFor });
  if (details?.risk) rows.push({ label: "Risk", value: details.risk });

  if (rows.length === 0 && !description) return null;

  return (
    <span style={{ position: "relative", display: "inline-block" }}>
      <span
        ref={buttonRef}
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#1a1a1a",
          color: "#666",
          fontSize: 12,
          cursor: "help",
          border: "1px solid #333",
        }}
      >
        i
      </span>
      {visible && (
        <div
          ref={panelRef}
          style={{
            position: "absolute",
            [position === "above" ? "bottom" : "top"]: "calc(100% + 8px)",
            right: 0,
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 8,
            padding: 16,
            maxWidth: 320,
            width: 320,
            zIndex: 1000,
            boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            pointerEvents: "none",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 8 }}>
            {endpoint.name}
          </div>
          {description && (
            <div style={{ fontSize: 13, color: "#aaa", marginBottom: 12, lineHeight: 1.5 }}>
              {description}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {rows.map((row) => (
              <div key={row.label} style={{ display: "flex", fontSize: 12, lineHeight: 1.4 }}>
                <span style={{ color: "#666", minWidth: 80, flexShrink: 0 }}>{row.label}:</span>
                <span style={{ color: "#ccc" }}>{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}

function StatusDot({ color, size = 8 }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        display: "inline-block",
        boxShadow: `0 0 4px ${color}`,
        flexShrink: 0,
      }}
    />
  );
}

function StatusCard({ endpoint, wsData, isPrimary, primaryType }) {
  const { stats } = endpoint;
  const httpStatus = getHttpStatus(stats);
  const wsStatus = getWsStatus(wsData);
  const wsDetail = getWsDetail(wsData);
  const wsSupported = endpoint.wsSupported !== false && wsData?.wsSupported !== false;

  // Determine role label
  let roleLabel = "backup";
  let roleColor = "#555";
  if (primaryType === "both") {
    roleLabel = "PRIMARY";
    roleColor = "#22c55e";
  } else if (primaryType === "http") {
    roleLabel = "PRIMARY (HTTP)";
    roleColor = "#22c55e";
  } else if (primaryType === "ws") {
    roleLabel = "PRIMARY (WS)";
    roleColor = "#3b82f6";
  }

  // Overall status for border
  const isDown = httpStatus.label === "DOWN" && (!wsSupported || wsStatus.label === "DOWN");
  const borderColor = isDown ? STATUS_COLORS.down : isPrimary ? "#22c55e" : "#222";

  return (
    <div
      style={{
        background: "#111",
        border: `1px solid ${borderColor}`,
        borderRadius: 8,
        padding: "16px 20px",
        minWidth: 200,
        flex: "1 1 0",
        boxShadow: isPrimary ? "0 0 12px rgba(34,197,94,0.15)" : "none",
        position: "relative",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div style={{ fontSize: 13, color: "#888" }}>{endpoint.name}</div>
        <ProviderInfoPanel endpoint={endpoint} />
      </div>

      {/* HTTP status line */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 13 }}>
        <span style={{ color: "#555", fontWeight: 600, width: 32, fontSize: 11 }}>HTTP</span>
        <StatusDot color={httpStatus.color} />
        <span style={{ color: httpStatus.color, fontWeight: 600, fontSize: 12 }}>{httpStatus.label}</span>
        <span style={{ color: "#666", marginLeft: "auto", fontSize: 12 }}>
          {httpStatus.label !== "DOWN" ? `${stats?.avgLatency ?? "—"}ms` : "(timeout)"}
        </span>
      </div>

      {/* WS status line */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontSize: 13 }}>
        <span style={{ color: "#555", fontWeight: 600, width: 32, fontSize: 11 }}>WS</span>
        <StatusDot color={wsStatus.color} />
        <span style={{ color: wsStatus.color, fontWeight: 600, fontSize: 12 }}>
          {wsSupported ? wsStatus.label : "N/A"}
        </span>
        <span style={{ color: "#666", marginLeft: "auto", fontSize: 11 }}>
          {wsDetail}
        </span>
      </div>

      {/* Success rate */}
      <div style={{ fontSize: 13, color: "#aaa", marginBottom: 6 }}>
        <Tooltip text="Percentage of HTTP health checks that got a valid response over the last 60 checks. 100% = never failed, below 90% = unreliable.">
          {stats?.successRate ?? "—"}% success
        </Tooltip>
      </div>

      {/* Role */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          color: roleColor,
          letterSpacing: 1,
        }}
      >
        {roleLabel}
      </div>

      {/* Slot drift */}
      {stats && stats.slotDrift > 0 && (
        <div style={{ fontSize: 11, color: "#eab308", marginTop: 4 }}>
          <Tooltip text="How many blocks behind this RPC is compared to the fastest one. Solana makes a new block every ~0.4 seconds. Drift of 1-2 is normal. Drift of 10+ means this RPC is serving stale data.">
            slot drift: {stats.slotDrift}
          </Tooltip>
        </div>
      )}
    </div>
  );
}

export default function StatusCards({ endpoints, wsStatus, failover }) {
  if (!endpoints || endpoints.length === 0) {
    return <div style={{ color: "#666", padding: 20 }}>Waiting for data...</div>;
  }

  const httpPrimary = failover?.httpPrimary;
  const wsPrimary = failover?.wsPrimary;

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {endpoints.map((ep) => {
        const ws = wsStatus?.find((w) => w.name === ep.name);
        const isHttpPrimary = ep.name === httpPrimary;
        const isWsPrimary = ep.name === wsPrimary;
        let primaryType = null;
        if (isHttpPrimary && isWsPrimary) primaryType = "both";
        else if (isHttpPrimary) primaryType = "http";
        else if (isWsPrimary) primaryType = "ws";

        return (
          <StatusCard
            key={ep.name}
            endpoint={ep}
            wsData={ws}
            isPrimary={isHttpPrimary || isWsPrimary}
            primaryType={primaryType}
          />
        );
      })}
    </div>
  );
}
