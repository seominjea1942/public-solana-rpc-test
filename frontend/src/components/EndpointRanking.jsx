import React from "react";

const MEDALS = ["#FFD700", "#C0C0C0", "#CD7F32"]; // gold, silver, bronze
const MEDAL_EMOJI = ["\ud83e\udd47", "\ud83e\udd48", "\ud83e\udd49"];

export default function EndpointRanking({ endpoints, wsStatus }) {
  if (!endpoints || endpoints.length === 0) {
    return <div style={{ color: "#666", padding: 20 }}>Waiting for data...</div>;
  }

  // Build combined data
  const combined = endpoints.map((ep) => {
    const ws = wsStatus?.find((w) => w.name === ep.name);
    return {
      name: ep.name,
      description: ep.description || "",
      successRate: ep.stats?.successRate ?? 0,
      avgLatency: ep.stats?.avgLatency ?? 9999,
      disconnects: ws?.disconnectCount ?? 0,
    };
  });

  // Rank by: success rate desc, then latency asc, then disconnects asc
  combined.sort((a, b) => {
    if (b.successRate !== a.successRate) return b.successRate - a.successRate;
    if (a.avgLatency !== b.avgLatency) return a.avgLatency - b.avgLatency;
    return a.disconnects - b.disconnects;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {combined.map((ep, i) => {
        const medal = i < 3 ? MEDAL_EMOJI[i] : null;
        const medalColor = i < 3 ? MEDALS[i] : "#444";

        return (
          <div
            key={ep.name}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              padding: "12px 0",
              borderBottom: i < combined.length - 1 ? "1px solid #1a1a1a" : "none",
            }}
          >
            {/* Rank */}
            <div
              style={{
                minWidth: 36,
                fontSize: 14,
                fontWeight: 700,
                color: medalColor,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              {medal && <span>{medal}</span>}
              <span style={{ color: "#555", fontSize: 12 }}>#{i + 1}</span>
            </div>

            {/* Name + description */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: "#e5e5e5" }}>{ep.name}</div>
              <div
                style={{
                  fontSize: 12,
                  color: "#666",
                  marginTop: 2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {ep.description}
              </div>
            </div>

            {/* Stats */}
            <div style={{ display: "flex", gap: 20, flexShrink: 0, alignItems: "center" }}>
              <div style={{ textAlign: "right", minWidth: 60 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color:
                      ep.successRate >= 99
                        ? "#22c55e"
                        : ep.successRate >= 90
                          ? "#eab308"
                          : "#ef4444",
                  }}
                >
                  {ep.successRate}%
                </div>
                <div style={{ fontSize: 10, color: "#555" }}>success</div>
              </div>
              <div style={{ textAlign: "right", minWidth: 60 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color:
                      ep.avgLatency < 300
                        ? "#22c55e"
                        : ep.avgLatency < 500
                          ? "#eab308"
                          : "#ef4444",
                  }}
                >
                  {ep.avgLatency}ms
                </div>
                <div style={{ fontSize: 10, color: "#555" }}>latency</div>
              </div>
              <div style={{ textAlign: "right", minWidth: 60 }}>
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: ep.disconnects === 0 ? "#22c55e" : ep.disconnects <= 3 ? "#eab308" : "#ef4444",
                  }}
                >
                  {ep.disconnects}
                </div>
                <div style={{ fontSize: 10, color: "#555" }}>disconnects</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
