import React, { useRef, useEffect } from "react";

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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

  const { failoverLog, totalFailovers, uptimeWithFailover, currentPrimary, totalRequests } = failover;

  return (
    <div>
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

      <div
        style={{
          display: "flex",
          gap: 24,
          padding: "12px 0",
          borderTop: "1px solid #222",
          fontSize: 13,
        }}
      >
        <div>
          <span style={{ color: "#666" }}>Current primary: </span>
          <span style={{ color: "#22c55e", fontWeight: 600 }}>{currentPrimary || "—"}</span>
        </div>
        <div>
          <span style={{ color: "#666" }}>Total failovers: </span>
          <span style={{ color: totalFailovers > 0 ? "#eab308" : "#aaa", fontWeight: 600 }}>
            {totalFailovers}
          </span>
        </div>
        <div>
          <span style={{ color: "#666" }}>Uptime with failover: </span>
          <span
            style={{
              color: uptimeWithFailover >= 99.9 ? "#22c55e" : uptimeWithFailover >= 99 ? "#eab308" : "#ef4444",
              fontWeight: 600,
            }}
          >
            {uptimeWithFailover}%
          </span>
        </div>
        <div>
          <span style={{ color: "#666" }}>Requests: </span>
          <span style={{ color: "#aaa" }}>{totalRequests}</span>
        </div>
      </div>
    </div>
  );
}
