const WebSocket = require("ws");
const {
  RPC_ENDPOINTS,
  TEST_ACCOUNT,
  WS_HEARTBEAT_TIMEOUT,
  WS_MAX_RETRIES,
  WS_RECOVERY_INTERVAL,
  WS_PING_INTERVAL,
} = require("./config");
const { writeWsLog } = require("./database");

// In-memory store for WS status
const wsData = new Map();
const wsConnections = new Map();

function initWsData() {
  for (const ep of RPC_ENDPOINTS) {
    wsData.set(ep.name, {
      name: ep.name,
      wsSupported: !!ep.ws,
      status: ep.ws ? "disconnected" : "unsupported",
      connectedAt: null,
      lastMessageAt: null,
      messageCount: 0,
      disconnectCount: 0,
      avgTimeBetweenMessages: 0,
      connectionUptime: 0,
      lastDisconnectReason: null,
      reconnectHistory: [],
      _consecutiveConnectFailures: 0,
      _startTime: Date.now(),
      _connectedTime: 0,
      _lastConnectedAt: null,
      _messageTimes: [],
    });
  }
}

function connectWs(endpoint) {
  const data = wsData.get(endpoint.name);
  if (!data) return;

  if (data._consecutiveConnectFailures >= WS_MAX_RETRIES) {
    data.status = "disconnected";
    return;
  }

  // Clean up any existing connection before creating a new one
  const existing = wsConnections.get(endpoint.name);
  if (existing) {
    if (existing.heartbeatTimer) clearTimeout(existing.heartbeatTimer);
    if (existing.pingTimer) clearInterval(existing.pingTimer);
    if (existing.ws && existing.ws.readyState !== WebSocket.CLOSED) {
      try { existing.ws.close(1000, "reconnecting"); } catch {}
    }
  }

  data.status = "connecting";

  let ws;
  try {
    ws = new WebSocket(endpoint.ws);
  } catch (err) {
    handleDisconnect(endpoint, err.message);
    return;
  }

  let heartbeatTimer = null;
  let pingTimer = null;

  function resetHeartbeat() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      try { writeWsLog(endpoint.name, "heartbeat_timeout", null, `No message for ${WS_HEARTBEAT_TIMEOUT / 1000}s`); } catch {}
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "heartbeat timeout");
      }
    }, WS_HEARTBEAT_TIMEOUT);
    // Update stored timer reference
    const conn = wsConnections.get(endpoint.name);
    if (conn) conn.heartbeatTimer = heartbeatTimer;
  }

  ws.on("open", () => {
    data.status = "connected";
    data.connectedAt = Date.now();
    data._lastConnectedAt = Date.now();
    data._consecutiveConnectFailures = 0;

    try { writeWsLog(endpoint.name, "connected", null, null); } catch {}

    // Subscribe to account updates
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "accountSubscribe",
        params: [
          TEST_ACCOUNT,
          { encoding: "base64", commitment: "confirmed" },
        ],
      })
    );

    resetHeartbeat();

    // Start periodic ping to keep the connection alive
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.ping(); } catch {}
      }
    }, WS_PING_INTERVAL);

    const conn = wsConnections.get(endpoint.name);
    if (conn) conn.pingTimer = pingTimer;
  });

  // Pong responses from the server also prove the connection is alive
  ws.on("pong", () => {
    resetHeartbeat();
  });

  ws.on("message", () => {
    const now = Date.now();
    data.lastMessageAt = now;
    data.messageCount++;
    data._messageTimes.push(now);

    // Keep only last 100 message times for avg calculation
    if (data._messageTimes.length > 100) {
      data._messageTimes.shift();
    }

    // Calculate average time between messages
    if (data._messageTimes.length >= 2) {
      const gaps = [];
      for (let i = 1; i < data._messageTimes.length; i++) {
        gaps.push(data._messageTimes[i] - data._messageTimes[i - 1]);
      }
      data.avgTimeBetweenMessages =
        Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000) * 10) / 10;
    }

    resetHeartbeat();
  });

  ws.on("close", (code, reason) => {
    const reasonStr = reason?.toString() || `code ${code}`;
    handleDisconnect(endpoint, reasonStr);
  });

  ws.on("error", (err) => {
    try { writeWsLog(endpoint.name, "error", null, err.message); } catch {}
    // Error is usually followed by close, but handle it just in case
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
  });

  wsConnections.set(endpoint.name, { ws, heartbeatTimer, pingTimer });
}

function handleDisconnect(endpoint, reason) {
  const data = wsData.get(endpoint.name);
  if (!data) return;

  // Track connected time
  if (data._lastConnectedAt) {
    data._connectedTime += Date.now() - data._lastConnectedAt;
    data._lastConnectedAt = null;
  }

  data.status = "disconnected";
  data.disconnectCount++;
  data.lastDisconnectReason = reason;
  data._consecutiveConnectFailures++;

  // Log disconnect with connection duration
  const connDuration = data._lastConnectedAt ? Date.now() - data._lastConnectedAt : null;
  try { writeWsLog(endpoint.name, "disconnected", connDuration, reason); } catch {}

  // Update uptime
  const totalTime = Date.now() - data._startTime;
  data.connectionUptime = totalTime > 0
    ? Math.round((data._connectedTime / totalTime) * 1000) / 10
    : 0;

  // Record in reconnect history
  data.reconnectHistory.push({
    at: Date.now(),
    reason,
    reconnectedAfter: null,
  });
  if (data.reconnectHistory.length > 10) {
    data.reconnectHistory.shift();
  }

  // Clean up timers
  const conn = wsConnections.get(endpoint.name);
  if (conn?.heartbeatTimer) clearTimeout(conn.heartbeatTimer);
  if (conn?.pingTimer) clearInterval(conn.pingTimer);

  // Attempt reconnect if under retry limit (exponential backoff)
  if (data._consecutiveConnectFailures < WS_MAX_RETRIES) {
    const delay = Math.min(1000 * Math.pow(2, data._consecutiveConnectFailures - 1), 30000);
    setTimeout(() => {
      const reconnectStart = Date.now();
      connectWs(endpoint);

      // Update reconnectedAfter once connected
      const checkConnected = setInterval(() => {
        if (data.status === "connected") {
          const lastEntry = data.reconnectHistory[data.reconnectHistory.length - 1];
          if (lastEntry) {
            lastEntry.reconnectedAfter = Date.now() - reconnectStart;
          }
          clearInterval(checkConnected);
        }
      }, 100);

      // Stop checking after 10 seconds
      setTimeout(() => clearInterval(checkConnected), 10000);
    }, delay);
  }
}

// Periodically recover dead connections that exhausted their retries
function startRecoveryTimer() {
  setInterval(() => {
    for (const ep of RPC_ENDPOINTS) {
      if (!ep.ws) continue;
      const data = wsData.get(ep.name);
      if (!data) continue;

      // Only recover endpoints that have given up (hit max retries)
      if (data._consecutiveConnectFailures >= WS_MAX_RETRIES && data.status === "disconnected") {
        try { writeWsLog(ep.name, "recovery_attempt", null, `Retrying after ${WS_RECOVERY_INTERVAL / 1000}s cooldown`); } catch {}
        data._consecutiveConnectFailures = 0;
        connectWs(ep);
      }
    }
  }, WS_RECOVERY_INTERVAL);
}

function updateUptimes() {
  for (const [, data] of wsData) {
    if (data._lastConnectedAt) {
      const currentConnectedTime = data._connectedTime + (Date.now() - data._lastConnectedAt);
      const totalTime = Date.now() - data._startTime;
      data.connectionUptime = totalTime > 0
        ? Math.round((currentConnectedTime / totalTime) * 1000) / 10
        : 0;
    }
  }
}

function startWsTesting() {
  for (const ep of RPC_ENDPOINTS) {
    if (!ep.ws) continue; // skip endpoints without WebSocket support
    connectWs(ep);
  }

  // Periodically update uptime stats
  setInterval(updateUptimes, 5000);

  // Periodically recover dead connections
  startRecoveryTimer();
}

function getAllWsStatus() {
  const statuses = [];
  for (const [name, data] of wsData) {
    statuses.push({
      name,
      wsSupported: data.wsSupported,
      status: data.status,
      connectedAt: data.connectedAt,
      lastMessageAt: data.lastMessageAt,
      messageCount: data.messageCount,
      disconnectCount: data.disconnectCount,
      avgTimeBetweenMessages: data.avgTimeBetweenMessages,
      connectionUptime: data.connectionUptime,
      lastDisconnectReason: data.lastDisconnectReason,
      reconnectHistory: data.reconnectHistory,
    });
  }
  return statuses;
}

function closeAllWs() {
  for (const [, conn] of wsConnections) {
    if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.close(1000, "shutdown");
    }
  }
}

module.exports = {
  initWsData,
  startWsTesting,
  getAllWsStatus,
  closeAllWs,
};
