import React from "react";
import Tooltip from "./Tooltip";

function timeSince(timestamp) {
  if (!timestamp) return "—";
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

const HEADER_TOOLTIPS = {
  Uptime:
    "Percentage of time this WebSocket connection has been alive since monitoring started. 100% = never disconnected.",
  Messages:
    "Total number of messages received from this WebSocket connection. More messages = more active and reliable.",
  "Avg Gap":
    "Average time between messages. Solana produces blocks every ~0.4 seconds, so gaps under 5 seconds are normal. Gaps over 30 seconds mean the connection is likely dead.",
};

const HEADERS = ["Endpoint", "Status", "Uptime", "Messages", "Avg Gap", "Disconnects", "Last Msg"];

export default function WebSocketStatus({ wsStatus }) {
  if (!wsStatus || wsStatus.length === 0) {
    return <div style={{ color: "#666", padding: 20 }}>Waiting for WebSocket data...</div>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ borderBottom: "1px solid #222" }}>
            {HEADERS.map((h) => (
              <th
                key={h}
                style={{
                  textAlign: "left",
                  padding: "8px 12px",
                  color: "#666",
                  fontWeight: 500,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {HEADER_TOOLTIPS[h] ? (
                  <Tooltip text={HEADER_TOOLTIPS[h]}>{h}</Tooltip>
                ) : (
                  h
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {wsStatus.map((ws) => {
            const isUnsupported = ws.wsSupported === false || ws.status === "unsupported";
            const isLive = ws.status === "connected";

            if (isUnsupported) {
              return (
                <tr key={ws.name} style={{ borderBottom: "1px solid #1a1a1a", opacity: 0.5 }}>
                  <td style={{ padding: "10px 12px", fontWeight: 500 }}>{ws.name}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <span style={{ color: "#555", fontWeight: 600, fontSize: 12 }}>N/A</span>
                  </td>
                  <td colSpan={5} style={{ padding: "10px 12px", color: "#555", fontSize: 12 }}>
                    WebSocket not supported by this provider
                  </td>
                </tr>
              );
            }

            return (
              <tr key={ws.name} style={{ borderBottom: "1px solid #1a1a1a" }}>
                <td style={{ padding: "10px 12px", fontWeight: 500 }}>{ws.name}</td>
                <td style={{ padding: "10px 12px" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: isLive ? "#22c55e" : "#ef4444",
                        display: "inline-block",
                        boxShadow: `0 0 4px ${isLive ? "#22c55e" : "#ef4444"}`,
                      }}
                    />
                    <span style={{ color: isLive ? "#22c55e" : "#ef4444", fontWeight: 600, fontSize: 12 }}>
                      {isLive ? "LIVE" : ws.status === "connecting" ? "CONNECTING" : "DEAD"}
                    </span>
                  </span>
                </td>
                <td style={{ padding: "10px 12px", color: "#aaa" }}>{ws.connectionUptime}%</td>
                <td style={{ padding: "10px 12px", color: "#aaa" }}>{ws.messageCount}</td>
                <td style={{ padding: "10px 12px", color: "#aaa" }}>
                  {ws.avgTimeBetweenMessages ? `${ws.avgTimeBetweenMessages}s` : "—"}
                </td>
                <td style={{ padding: "10px 12px", color: ws.disconnectCount > 5 ? "#ef4444" : "#aaa" }}>
                  {ws.disconnectCount}
                </td>
                <td style={{ padding: "10px 12px", color: "#666", fontSize: 12 }}>
                  {timeSince(ws.lastMessageAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
