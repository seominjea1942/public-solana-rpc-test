const express = require("express");
const cors = require("cors");
const { RPC_ENDPOINTS, HEALTH_CHECK_INTERVAL, HELIUS_API_KEY } = require("./config");
const { initEndpointData, runHealthCheck, getAllStats, getLatencyHistory } = require("./rpc-tester");
const { initWsData, startWsTesting, getAllWsStatus, closeAllWs } = require("./ws-tester");
const { startFailoverSimulator, getFailoverStatus, stopFailoverSimulator } = require("./failover");

const app = express();
const PORT = process.env.PORT || 3001;

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
const startTime = Date.now();

async function start() {
  console.log("===========================================");
  console.log("  Solana RPC Health Tester");
  console.log("===========================================");
  console.log(`  Testing ${RPC_ENDPOINTS.length} endpoints:`);
  for (const ep of RPC_ENDPOINTS) {
    console.log(`    • ${ep.name}`);
  }
  if (!HELIUS_API_KEY) {
    console.log("");
    console.log("  ⚠ HELIUS_API_KEY not set — Helius endpoint skipped");
    console.log("    Set it with: HELIUS_API_KEY=your_key node server.js");
  }
  console.log("===========================================\n");

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
  stopFailoverSimulator();
  closeAllWs();

  // Close SSE connections
  for (const client of sseClients) {
    try {
      client.end();
    } catch {}
  }
  sseClients.clear();

  console.log("All connections closed. Goodbye.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
