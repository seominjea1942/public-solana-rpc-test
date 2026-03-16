import React, { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

const COLORS = ["#22c55e", "#3b82f6", "#eab308", "#a855f7", "#ef4444", "#06b6d4"];

const TIME_RANGES = [
  { label: "5m", ms: 5 * 60 * 1000 },
  { label: "10m", ms: 10 * 60 * 1000 },
  { label: "30m", ms: 30 * 60 * 1000 },
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "All", ms: 0 },
];

const TARGET_POINTS = 300;

function downsample(dataPoints, targetCount) {
  if (dataPoints.length <= targetCount) return dataPoints;

  const bucketSize = Math.ceil(dataPoints.length / targetCount);
  const result = [];

  for (let i = 0; i < dataPoints.length; i += bucketSize) {
    const bucket = dataPoints.slice(i, i + bucketSize);
    const point = { time: bucket[0].time };

    // For each endpoint key (not "time"), average non-null values
    const keys = Object.keys(bucket[0]).filter((k) => k !== "time");
    for (const key of keys) {
      const vals = bucket.map((b) => b[key]).filter((v) => v != null);
      point[key] = vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    }

    result.push(point);
  }

  return result;
}

function formatTickByRange(t, rangeMs) {
  const d = new Date(t);
  if (rangeMs > 0 && rangeMs <= 30 * 60 * 1000) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  if (rangeMs <= 6 * 60 * 60 * 1000) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  // 24h+ or All
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function LatencyChart({ latencyHistory, endpointNames }) {
  const [selectedRange, setSelectedRange] = useState(0); // index into TIME_RANGES

  const range = TIME_RANGES[selectedRange];

  const chartData = useMemo(() => {
    if (!latencyHistory || latencyHistory.length === 0) return [];

    const now = Date.now();
    const cutoff = range.ms > 0 ? now - range.ms : 0;

    // Filter by time range
    const filtered = latencyHistory.filter((e) => e.timestamp >= cutoff);

    // Group by timestamp
    const byTime = new Map();
    for (const entry of filtered) {
      const key = entry.timestamp;
      if (!byTime.has(key)) {
        byTime.set(key, { time: key });
      }
      // null values = endpoint was DOWN, show gap in chart
      byTime.get(key)[entry.name] = entry.avgLatency;
    }

    const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    return downsample(sorted, TARGET_POINTS);
  }, [latencyHistory, range]);

  if (chartData.length === 0) {
    return (
      <div style={{ color: "#666", padding: 20, textAlign: "center" }}>
        Collecting latency data...
      </div>
    );
  }

  const names = endpointNames || [];

  return (
    <div>
      {/* Time range selector */}
      <div style={{ display: "flex", gap: 0, marginBottom: 16 }}>
        {TIME_RANGES.map((r, i) => (
          <button
            key={r.label}
            onClick={() => setSelectedRange(i)}
            style={{
              padding: "6px 14px",
              fontSize: 12,
              fontWeight: 600,
              border: "1px solid #333",
              borderRight: i < TIME_RANGES.length - 1 ? "none" : "1px solid #333",
              borderRadius:
                i === 0
                  ? "6px 0 0 6px"
                  : i === TIME_RANGES.length - 1
                    ? "0 6px 6px 0"
                    : 0,
              background: selectedRange === i ? "#22c55e" : "#1a1a1a",
              color: selectedRange === i ? "#000" : "#888",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {r.label}
          </button>
        ))}
        <span style={{ marginLeft: 12, fontSize: 11, color: "#555", alignSelf: "center" }}>
          {chartData.length} points
        </span>
      </div>

      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" />
          <XAxis
            dataKey="time"
            tick={{ fill: "#666", fontSize: 11 }}
            tickFormatter={(t) => formatTickByRange(t, range.ms)}
            stroke="#333"
          />
          <YAxis
            tick={{ fill: "#666", fontSize: 11 }}
            stroke="#333"
            label={{ value: "ms", position: "insideLeft", fill: "#666", fontSize: 12 }}
          />
          <Tooltip
            contentStyle={{
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 6,
              fontSize: 12,
            }}
            labelFormatter={(t) => {
              const d = new Date(t);
              return d.toLocaleDateString() + " " + d.toLocaleTimeString();
            }}
            formatter={(value, name) => [value != null ? `${value}ms` : "DOWN", name]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: "#aaa" }} />
          {names.map((name, i) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
