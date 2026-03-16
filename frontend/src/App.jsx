import React, { useState, useEffect } from "react";
import { useSSE } from "./hooks/useSSE";
import StatusCards from "./components/StatusCards";
import LatencyChart from "./components/LatencyChart";
import WebSocketStatus from "./components/WebSocketStatus";
import FailoverLog from "./components/FailoverLog";
import EndpointRanking from "./components/EndpointRanking";
import PipelineStatus from "./components/PipelineStatus";
import RawDataSection from "./components/RawDataSection";
import ParsedPoolData from "./components/ParsedPoolData";
import TransactionsSection from "./components/TransactionsSection";

function formatUptime(startTime) {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m ${s}s`;
  }
  return `${m}m ${s}s`;
}

function SectionHeader({ title }) {
  return (
    <h2
      style={{
        fontSize: 14,
        fontWeight: 600,
        color: "#888",
        textTransform: "uppercase",
        letterSpacing: 1,
        marginBottom: 12,
      }}
    >
      {title}
    </h2>
  );
}

export default function App() {
  const { data, connected } = useSSE("/api/stream");
  const [startTime] = useState(Date.now());
  const [uptime, setUptime] = useState("0m 0s");

  useEffect(() => {
    const interval = setInterval(() => {
      setUptime(formatUptime(startTime));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const endpoints = data?.endpoints || [];
  const failover = data?.failover || null;
  const wsStatus = data?.wsStatus || [];
  const latencyHistory = data?.latencyHistory || [];
  const heliusEnabled = data?.heliusEnabled;
  const dbStats = data?.dbStats || null;
  const pools = data?.pools || [];
  const parsedPool = data?.parsedPool || null;
  const pipeline = data?.pipeline || null;
  const endpointNames = endpoints.map((e) => e.name);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 20px" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
          paddingBottom: 16,
          borderBottom: "1px solid #222",
        }}
      >
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>
            Solana RPC Health Monitor
          </h1>
          {heliusEnabled === false && (
            <div style={{ fontSize: 12, color: "#eab308", marginTop: 4 }}>
              Helius endpoint skipped — set HELIUS_API_KEY env var to include it
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: connected ? "#22c55e" : "#ef4444",
              display: "inline-block",
            }}
          />
          <span style={{ color: "#666" }}>
            {connected ? "Connected" : "Disconnected"}
          </span>
          <span style={{ color: "#444" }}>|</span>
          <span style={{ color: "#666" }}>Running: {uptime}</span>
          {dbStats?.collectingSince && (
            <>
              <span style={{ color: "#444" }}>|</span>
              <span style={{ color: "#666" }}>
                Data: {formatUptime(dbStats.collectingSince)}
              </span>
              <span style={{ color: "#555", fontSize: 11 }}>
                ({(dbStats.healthChecks || 0).toLocaleString()} checks)
              </span>
            </>
          )}
        </div>
      </div>

      {/* Section 1: Status Cards */}
      <div style={{ marginBottom: 28 }}>
        <SectionHeader title="RPC Status" />
        <StatusCards endpoints={endpoints} wsStatus={wsStatus} failover={failover} />
      </div>

      {/* Section 2: Latency Chart */}
      <div
        style={{
          marginBottom: 28,
          background: "#111",
          border: "1px solid #222",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <SectionHeader title="Latency Over Time" />
        <LatencyChart latencyHistory={latencyHistory} endpointNames={endpointNames} />
      </div>

      {/* Section 3: WebSocket Status */}
      <div
        style={{
          marginBottom: 28,
          background: "#111",
          border: "1px solid #222",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <SectionHeader title="WebSocket Connections" />
        <WebSocketStatus wsStatus={wsStatus} />
      </div>

      {/* Section 4: Failover Log */}
      <div
        style={{
          marginBottom: 28,
          background: "#111",
          border: "1px solid #222",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <SectionHeader title="Failover Simulator" />
        <FailoverLog failover={failover} />
      </div>

      {/* Section 5: Endpoint Ranking */}
      <div
        style={{
          marginBottom: 28,
          background: "#111",
          border: "1px solid #222",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <SectionHeader title="Endpoint Ranking" />
        <EndpointRanking endpoints={endpoints} wsStatus={wsStatus} />
      </div>

      {/* Section 6: Pipeline Status */}
      <div
        style={{
          marginBottom: 28,
          background: "#111",
          border: "1px solid #222",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <SectionHeader title="Pipeline Status" />
        <PipelineStatus pipeline={pipeline} />
      </div>

      {/* Section 7: Parsed Pool Data (Raydium AMM v4) */}
      <div
        style={{
          marginBottom: 28,
          background: "#111",
          border: "1px solid #222",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <SectionHeader title="Raydium AMM v4 — Parsed Pool State" />
        <ParsedPoolData parsedPool={parsedPool} />
      </div>

      {/* Section 8: Transactions */}
      <div
        style={{
          marginBottom: 28,
          background: "#111",
          border: "1px solid #222",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <SectionHeader title="Transaction Monitor" />
        <TransactionsSection />
      </div>

      {/* Section 9: Raw Data */}
      <div
        style={{
          marginBottom: 28,
          background: "#111",
          border: "1px solid #222",
          borderRadius: 8,
          padding: 20,
        }}
      >
        <SectionHeader title="Raw Data Collection" />
        <RawDataSection dbStats={dbStats} pools={pools} />
      </div>
    </div>
  );
}
