const express = require("express");
const cors = require("cors");
const path = require("path");
const { RPC_ENDPOINTS, HEALTH_CHECK_INTERVAL, HELIUS_API_KEY, POOL_ACCOUNTS } = require("./config");
const { initEndpointData, runHealthCheck, getAllStats, getLatencyHistory } = require("./rpc-tester");
const { initWsData, startWsTesting, getAllWsStatus, closeAllWs } = require("./ws-tester");
const { startFailoverSimulator, getFailoverStatus, stopFailoverSimulator } = require("./failover");
const {
  DB_PATH, cleanupOldData, closeDb, aggregateUptimeSummary,
  getUptimeStats, generateReport, getRawLatest, getRawCompare, getRawHistory, getRawExportCsv,
  getParsedLatest, getParsedHistory, getDbStats,
} = require("./database");

const app = express();
const PORT = process.env.PORT || 3099;

app.use(cors());
app.use(express.json());

// SSE clients
const sseClients = new Set();

// ── API Routes ──

app.get("/api/health", (req, res) => {
  res.json({
    endpoints: getAllStats(),
    heliusEnabled: !!HELIUS_API_KEY,
    endpointCount: RPC_ENDPOINTS.length,
  });
});

app.get("/api/stats", (req, res) => {
  res.json({
    endpoints: getAllStats(),
    latencyHistory: getLatencyHistory(),
  });
});

app.get("/api/failover-log", (req, res) => {
  res.json(getFailoverStatus());
});

app.get("/api/ws-status", (req, res) => {
  res.json(getAllWsStatus());
});

// ── SQLite API Routes ──

app.get("/api/uptime", (req, res) => {
  const hours = parseFloat(req.query.hours) || 24;
  res.json(getUptimeStats(hours));
});

app.get("/api/report", (req, res) => {
  const hours = parseFloat(req.query.hours) || 24;
  res.type("text/plain").send(generateReport(hours));
});

app.get("/api/raw/latest", (req, res) => {
  const dbStats = getDbStats();
  const collectingSince = dbStats.collectingSince;
  const duration = collectingSince ? Date.now() - collectingSince : 0;
  const hours = Math.floor(duration / 3600000);
  const mins = Math.floor((duration % 3600000) / 60000);
  res.json({
    pools: getRawLatest(),
    totalSnapshots: dbStats.rawAccountData,
    monitoringDuration: `${hours}h ${mins}m`,
    dbSizeMB: dbStats.dbSizeMB,
  });
});

app.get("/api/raw/compare", (req, res) => {
  res.json({ comparison: getRawCompare() });
});

app.get("/api/raw/history", (req, res) => {
  const pool = req.query.pool;
  const hours = parseFloat(req.query.hours) || 1;
  if (!pool) return res.status(400).json({ error: "pool query param required" });
  res.json(getRawHistory(pool, hours));
});

app.get("/api/raw/export", (req, res) => {
  const pool = req.query.pool;
  const hours = parseFloat(req.query.hours) || 24;
  if (!pool) return res.status(400).json({ error: "pool query param required" });
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename=raw-${pool.slice(0, 8)}-${hours}h.csv`);
  res.send(getRawExportCsv(pool, hours));
});

// ── Parsed Pool Data API Routes ──

app.get("/api/parsed/latest", (req, res) => {
  res.json(getParsedLatest() || { error: "No parsed data yet" });
});

app.get("/api/parsed/history", (req, res) => {
  const pool = req.query.pool;
  const hours = parseFloat(req.query.hours) || 1;
  if (!pool) return res.status(400).json({ error: "pool query param required" });
  res.json(getParsedHistory(pool, hours));
});

app.get("/api/db/stats", (req, res) => {
  res.json(getDbStats());
});

app.get("/api/db/download", (req, res) => {
  res.download(DB_PATH, "rpc-data.db");
});

app.get("/api/pools", (req, res) => {
  res.json({ pools: POOL_ACCOUNTS });
});

// SSE stream
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial data
  const initialData = buildUpdatePayload();
  res.write(`data: ${JSON.stringify(initialData)}\n\n`);

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

function buildUpdatePayload() {
  return {
    type: "update",
    timestamp: Date.now(),
    endpoints: getAllStats(),
    failover: getFailoverStatus(),
    wsStatus: getAllWsStatus(),
    latencyHistory: getLatencyHistory(),
    heliusEnabled: !!HELIUS_API_KEY,
    dbStats: getDbStats(),
    pools: POOL_ACCOUNTS,
    parsedPool: getParsedLatest(),
  };
}

function broadcastUpdate() {
  const payload = buildUpdatePayload();
  const data = `data: ${JSON.stringify(payload)}\n\n`;

  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ── Start everything ──

let healthCheckInterval = null;
let aggregationInterval = null;
const startTime = Date.now();

async function start() {
  console.log("===========================================");
  console.log("  Solana RPC Health Tester");
  console.log("===========================================");
  console.log(`  Testing ${RPC_ENDPOINTS.length} endpoints:`);
  for (const ep of RPC_ENDPOINTS) {
    console.log(`    • ${ep.name}`);
  }
  console.log(`  Monitoring ${POOL_ACCOUNTS.length} pools (rotating)`);
  if (!HELIUS_API_KEY) {
    console.log("");
    console.log("  ⚠ HELIUS_API_KEY not set — Helius endpoint skipped");
    console.log("    Set it with: HELIUS_API_KEY=your_key node server.js");
  }
  console.log("===========================================\n");

  // Cleanup old data on startup
  console.log("Cleaning up old database records...");
  cleanupOldData();

  // Initialize data stores
  initEndpointData();
  initWsData();

  // Start health checks
  console.log("Starting HTTP health checks (every 5s)...");
  await runHealthCheck(); // first run immediately
  healthCheckInterval = setInterval(async () => {
    await runHealthCheck();
    broadcastUpdate();
  }, HEALTH_CHECK_INTERVAL);

  // Start WebSocket testing
  console.log("Starting WebSocket connection tests...");
  startWsTesting();

  // Start failover simulator
  console.log("Starting failover simulator (every 2s)...");
  startFailoverSimulator();

  // Start uptime_summary aggregation every 5 minutes
  console.log("Starting uptime aggregation (every 5m)...");
  const FIVE_MINUTES = 5 * 60 * 1000;
  aggregationInterval = setInterval(() => {
    const now = Date.now();
    const windowEnd = now;
    const windowStart = now - FIVE_MINUTES;
    const wsStatuses = getAllWsStatus();
    for (const ep of RPC_ENDPOINTS) {
      const ws = wsStatuses.find((w) => w.name === ep.name);
      try {
        aggregateUptimeSummary(windowStart, windowEnd, ep.name, ws);
      } catch (err) {
        console.error(`Aggregation error for ${ep.name}:`, err.message);
      }
    }
  }, FIVE_MINUTES);

  // Start server
  app.listen(PORT, () => {
    console.log(`\nServer running on http://localhost:${PORT}`);
    console.log(`SSE stream: http://localhost:${PORT}/api/stream`);
    console.log(`Dashboard: http://localhost:5173\n`);
  });
}

// ── Graceful shutdown ──

function shutdown() {
  console.log("\nShutting down...");

  if (healthCheckInterval) clearInterval(healthCheckInterval);
  if (aggregationInterval) clearInterval(aggregationInterval);
  stopFailoverSimulator();
  closeAllWs();

  // Close SSE connections
  for (const client of sseClients) {
    try {
      client.end();
    } catch {}
  }
  sseClients.clear();

  // Close database
  try { closeDb(); } catch {}

  console.log("All connections closed. Goodbye.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
