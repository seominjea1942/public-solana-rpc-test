import React, { useMemo } from "react";
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

export default function LatencyChart({ latencyHistory, endpointNames }) {
  const chartData = useMemo(() => {
    if (!latencyHistory || latencyHistory.length === 0) return [];

    // Group by timestamp, create { time, "Solana Foundation": 142, "PublicNode": 198, ... }
    const byTime = new Map();

    for (const entry of latencyHistory) {
      const key = entry.timestamp;
      if (!byTime.has(key)) {
        byTime.set(key, { time: key });
      }
      byTime.get(key)[entry.name] = entry.avgLatency;
    }

    return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  }, [latencyHistory]);

  if (chartData.length === 0) {
    return (
      <div style={{ color: "#666", padding: 20, textAlign: "center" }}>
        Collecting latency data...
      </div>
    );
  }

  const names = endpointNames || [];

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#222" />
        <XAxis
          dataKey="time"
          tick={{ fill: "#666", fontSize: 11 }}
          tickFormatter={(t) => {
            const d = new Date(t);
            return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          }}
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
          labelFormatter={(t) => new Date(t).toLocaleTimeString()}
          formatter={(value, name) => [`${value}ms`, name]}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: "#aaa" }}
        />
        {names.map((name, i) => (
          <Line
            key={name}
            type="monotone"
            dataKey={name}
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
