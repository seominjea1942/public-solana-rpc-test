import React from "react";
import InfoTip from "./Tooltip";

const DEX_COLORS = {
  Raydium: "#8b5cf6",
  Orca: "#06b6d4",
  Meteora: "#f59e0b",
};

const STATUS_STYLES = {
  ok: { color: "#22c55e", icon: "\u25cf", label: "OK" },
  error: { color: "#ef4444", icon: "\u25cf", label: "ERR" },
  skipped: { color: "#eab308", icon: "\u25cb", label: "SKIP" },
  pending: { color: "#555", icon: "\u25cb", label: "..." },
};

function formatAgo(ts) {
  if (!ts) return "\u2014";
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function TaskLabel({ task }) {
  if (task === "poolState") return <span style={{ color: "#8b5cf6" }}>Pool State (A)</span>;
  if (task === "txMonitor") return <span style={{ color: "#3b82f6" }}>Tx Monitor (B)</span>;
  return <span>{task}</span>;
}

function StatusBadge({ status, durationMs, items }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.pending;
  let detail = "";
  if (status === "ok" && durationMs != null) {
    detail = ` ${durationMs}ms`;
    if (items != null && items > 0) detail += ` \u00b7 ${items} new`;
  }
  if (status === "error") detail = "";
  return (
    <span style={{ color: s.color, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      {s.icon} {s.label}{detail}
    </span>
  );
}

function RateLimitBar({ rateLimit }) {
  if (!rateLimit) return null;
  const { currentReqPerSec, maxPerSecond, peakReqPerSec, total429s, throttledCount } = rateLimit;
  const pct = Math.min(100, (currentReqPerSec / maxPerSecond) * 100);
  const barColor = pct > 80 ? "#ef4444" : pct > 50 ? "#eab308" : "#22c55e";

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
        <span style={{ color: "#666" }}>
          <InfoTip text="Current rate of RPC calls through the pipeline rate limiter, measured over a 5-second rolling window. The bar shows usage relative to the configured maximum.">
            Rate Limit
          </InfoTip>
        </span>
        <span style={{ color: "#aaa", fontFamily: "monospace" }}>
          {currentReqPerSec} / {maxPerSecond} req/sec
        </span>
      </div>

      {/* Bar */}
      <div style={{
        height: 8,
        background: "#1a1a1a",
        borderRadius: 4,
        overflow: "hidden",
        marginBottom: 8,
      }}>
        <div style={{
          width: `${pct}%`,
          height: "100%",
          background: barColor,
          borderRadius: 4,
          transition: "width 0.5s ease",
        }} />
      </div>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 20, fontSize: 11, color: "#555", flexWrap: "wrap" }}>
        <span>
          <InfoTip text="The highest instantaneous request rate observed since the pipeline started. A peak close to the max means the scheduler is well-utilized.">
            Peak
          </InfoTip>: <span style={{ color: "#aaa" }}>{peakReqPerSec} req/sec</span>
        </span>
        <span>
          <InfoTip text="Number of times a request was delayed by the rate limiter because tokens were temporarily exhausted. Some throttling is normal; excessive throttling may indicate the schedule is too aggressive.">
            Throttled
          </InfoTip>: <span style={{ color: throttledCount > 0 ? "#eab308" : "#aaa" }}>{throttledCount}</span>
        </span>
        <span>
          <InfoTip text="Number of HTTP 429 'Too Many Requests' responses received from the RPC endpoint. Each 429 triggers a 2-second backoff. If this number is climbing, the rate limiter may need a lower cap or the cycle duration should increase.">
            429 errors
          </InfoTip>: <span style={{ color: total429s > 0 ? "#ef4444" : "#aaa" }}>{total429s}</span>
        </span>
      </div>
    </div>
  );
}

export default function PipelineStatus({ pipeline }) {
  if (!pipeline) {
    return (
      <div style={{ color: "#555", fontSize: 13, padding: "12px 0" }}>
        Waiting for pipeline scheduler to start...
      </div>
    );
  }

  const { cycleNumber, cycleDuration, isDegraded, uptime, tasks, rateLimit } = pipeline;

  // Sort: poolState tasks first (Part A), then txMonitor (Part B), within each group sort by DEX
  const sortedTasks = [...(tasks || [])].sort((a, b) => {
    if (a.task !== b.task) return a.task === "poolState" ? -1 : 1;
    return (a.dex || "").localeCompare(b.dex || "");
  });

  return (
    <div>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#666" }}>
          <span>
            <InfoTip text="How many complete 30-second cycles the scheduler has run. Each cycle fires 8 tasks (4 pools x 2 tasks) in a staggered pattern to avoid rate limits.">
              Cycle
            </InfoTip>: <span style={{ color: "#aaa", fontFamily: "monospace" }}>#{cycleNumber}</span>
          </span>
          <span>
            <InfoTip text="How long the pipeline scheduler has been running since server start.">
              Uptime
            </InfoTip>: <span style={{ color: "#aaa" }}>{uptime}</span>
          </span>
          <span>
            <InfoTip text="The length of one full scheduler cycle. Normally 30 seconds, but extends to 45 seconds automatically if rate limit pressure is detected (429 errors or high request rate).">
              Cycle length
            </InfoTip>: <span style={{ color: isDegraded ? "#eab308" : "#aaa" }}>
              {cycleDuration}s{isDegraded ? " (degraded)" : ""}
            </span>
          </span>
        </div>
      </div>

      {/* Task table */}
      <div style={{
        border: "1px solid #1a1a1a",
        borderRadius: 6,
        overflow: "hidden",
      }}>
        {/* Header row */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "140px 1fr 80px 1fr",
          padding: "8px 12px",
          background: "#0a0a0a",
          borderBottom: "1px solid #1a1a1a",
          fontSize: 10,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "#555",
        }}>
          <span>Task</span>
          <span>Pool</span>
          <span>Last Run</span>
          <span>Status</span>
        </div>

        {/* Task rows */}
        {sortedTasks.map((t, i) => {
          const dexColor = DEX_COLORS[t.dex] || "#666";
          return (
            <div
              key={`${t.task}-${t.poolAddress}`}
              style={{
                display: "grid",
                gridTemplateColumns: "140px 1fr 80px 1fr",
                padding: "6px 12px",
                borderBottom: i < sortedTasks.length - 1 ? "1px solid #111" : "none",
                background: i % 2 === 0 ? "#0d0d0d" : "transparent",
                alignItems: "center",
                fontSize: 12,
              }}
            >
              <TaskLabel task={t.task} />
              <span style={{ color: dexColor, fontSize: 12 }}>
                {t.pool?.replace(/ — SOL\/USDC/, "") || t.poolAddress?.slice(0, 8)}
              </span>
              <span style={{ color: "#666", fontSize: 11 }}>
                {formatAgo(t.lastRun)}
              </span>
              <StatusBadge
                status={t.lastStatus}
                durationMs={t.lastDurationMs}
                items={t.itemsProcessed}
              />
            </div>
          );
        })}
      </div>

      {/* Rate limit section */}
      <RateLimitBar rateLimit={rateLimit} />
    </div>
  );
}
