import React, { useRef, useEffect } from "react";
import Tooltip from "./Tooltip";

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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

export default function FailoverLog({ failover }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [failover?.failoverLog?.length]);

  if (!failover) {
    return <div style={{ color: "#666", padding: 20 }}>Waiting for failover data...</div>;
  }

  const {
    failoverLog, totalFailovers, uptimeWithFailover, totalRequests,
    httpPrimary, httpPrimaryLatency, wsPrimary, wsPrimaryUptime, wsPrimaryConnectedAt,
  } = failover;

  const wsConnectedDuration = wsPrimaryConnectedAt
    ? formatDuration(Date.now() - wsPrimaryConnectedAt)
    : null;

  return (
    <div>
      {/* HTTP/WS Primary indicators */}
      <div
        style={{
          display: "flex",
          gap: 20,
          marginBottom: 16,
          padding: "12px 16px",
          background: "#0d0d0d",
          borderRadius: 6,
          border: "1px solid #1a1a1a",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 13 }}>
          <span style={{ color: "#555", fontWeight: 600, fontSize: 11, marginRight: 8 }}>HTTP PRIMARY</span>
          <span style={{ color: "#22c55e", fontWeight: 600 }}>{httpPrimary || "—"}</span>
          {httpPrimaryLatency != null && (
            <span style={{ color: "#666", marginLeft: 6 }}>({httpPrimaryLatency}ms)</span>
          )}
        </div>
        <div style={{ fontSize: 13 }}>
          <span style={{ color: "#555", fontWeight: 600, fontSize: 11, marginRight: 8 }}>WS PRIMARY</span>
          <span style={{ color: "#3b82f6", fontWeight: 600 }}>{wsPrimary || "—"}</span>
          {wsPrimaryUptime != null && (
            <span style={{ color: "#666", marginLeft: 6 }}>
              ({wsConnectedDuration ? `connected ${wsConnectedDuration}` : ""}{wsPrimaryUptime != null ? `, ${wsPrimaryUptime}% uptime` : ""})
            </span>
          )}
        </div>
      </div>

      {/* Failover events */}
      <div
        ref={scrollRef}
        style={{
          maxHeight: 240,
          overflowY: "auto",
          marginBottom: 12,
        }}
      >
        {failoverLog.length === 0 ? (
          <div style={{ color: "#555", fontSize: 13, padding: "12px 0" }}>
            No failover events yet. Monitoring...
          </div>
        ) : (
          failoverLog.map((entry, i) => (
            <div
              key={i}
              style={{
                padding: "8px 0",
                borderBottom: "1px solid #1a1a1a",
                fontSize: 13,
              }}
            >
              <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
                <span style={{ color: "#666", fontSize: 12, fontFamily: "monospace", minWidth: 90 }}>
                  {formatTime(entry.timestamp)}
                </span>
                {entry.type && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "1px 5px",
                      borderRadius: 3,
                      background: entry.type === "http" ? "#22c55e22" : "#3b82f622",
                      color: entry.type === "http" ? "#22c55e" : "#3b82f6",
                      textTransform: "uppercase",
                    }}
                  >
                    {entry.type}
                  </span>
                )}
                <span>
                  <span style={{ color: "#ef4444" }}>{entry.from}</span>
                  <span style={{ color: "#555", margin: "0 6px" }}>&rarr;</span>
                  <span style={{ color: "#22c55e" }}>{entry.to}</span>
                </span>
              </div>
              <div style={{ color: "#666", fontSize: 11, marginLeft: 102, marginTop: 2 }}>
                reason: {entry.reason}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Stats bar */}
      <div
        style={{
          display: "flex",
          gap: 24,
          padding: "12px 0",
          borderTop: "1px solid #222",
          fontSize: 13,
          flexWrap: "wrap",
        }}
      >
        <div>
          <span style={{ color: "#666" }}>Total failovers: </span>
          <span style={{ color: totalFailovers > 0 ? "#eab308" : "#aaa", fontWeight: 600 }}>
            {totalFailovers}
          </span>
        </div>
        <div>
          <Tooltip text="What percentage of our requests succeeded when using automatic failover across all RPCs. This is the number that matters — it shows our effective reliability.">
            <span style={{ color: "#666" }}>Uptime with failover: </span>
            <span
              style={{
                color: uptimeWithFailover >= 99.9 ? "#22c55e" : uptimeWithFailover >= 99 ? "#eab308" : "#ef4444",
                fontWeight: 600,
              }}
            >
              {uptimeWithFailover}%
            </span>
          </Tooltip>
        </div>
        <div>
          <span style={{ color: "#666" }}>Requests: </span>
          <span style={{ color: "#aaa" }}>{totalRequests}</span>
        </div>
      </div>
    </div>
  );
}
