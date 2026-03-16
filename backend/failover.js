const { RPC_ENDPOINTS, TEST_ACCOUNT, HTTP_TIMEOUT, FAILOVER_POLL_INTERVAL } = require("./config");
const { getHealthiestEndpoint, getEndpointUrl, getAllStats, setCurrentPrimary } = require("./rpc-tester");
const { getAllWsStatus } = require("./ws-tester");
const { writeFailoverEvent, getRecentFailoverEvents } = require("./database");

const failoverState = {
  httpPrimary: null,
  wsPrimary: null,
  failoverLog: [],
  totalFailovers: 0,
  totalRequests: 0,
  successfulRequests: 0,
  uptimeWithFailover: 100,
};

let failoverInterval = null;

async function simulateRequest(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAccountInfo",
        params: [TEST_ACCOUNT, { encoding: "base64" }],
      }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      return { success: false, reason: "rate limited" };
    }

    const data = await res.json();
    if (data.error) {
      return { success: false, reason: data.error.message };
    }

    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message || "timeout" };
  } finally {
    clearTimeout(timeout);
  }
}

function pickBestWsPrimary() {
  const wsStatuses = getAllWsStatus();
  let best = null;
  let bestScore = -Infinity;

  for (const ws of wsStatuses) {
    if (!ws.wsSupported) continue;
    if (ws.status !== "connected") continue;

    // Score: uptime weight + message count as tiebreaker
    const score = ws.connectionUptime * 100 + ws.messageCount * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = ws.name;
    }
  }

  // If nothing is connected, pick the one with best uptime
  if (!best) {
    for (const ws of wsStatuses) {
      if (!ws.wsSupported) continue;
      const score = ws.connectionUptime;
      if (score > bestScore) {
        bestScore = score;
        best = ws.name;
      }
    }
  }

  return best;
}

async function failoverTick() {
  const healthiest = getHealthiestEndpoint();

  // Initialize HTTP primary
  if (!failoverState.httpPrimary) {
    failoverState.httpPrimary = healthiest || RPC_ENDPOINTS[0].name;
    setCurrentPrimary(failoverState.httpPrimary);
  }

  // Update WS primary
  const bestWs = pickBestWsPrimary();
  if (bestWs && bestWs !== failoverState.wsPrimary) {
    if (failoverState.wsPrimary) {
      const wsEvent = {
        timestamp: Date.now(),
        type: "ws",
        from: failoverState.wsPrimary,
        to: bestWs,
        reason: "better WS connection available",
      };
      failoverState.failoverLog.push(wsEvent);
      try { writeFailoverEvent(wsEvent); } catch {}
    }
    failoverState.wsPrimary = bestWs;
  }

  const primaryUrl = getEndpointUrl(failoverState.httpPrimary);
  if (!primaryUrl) return;

  failoverState.totalRequests++;

  const result = await simulateRequest(primaryUrl);

  if (result.success) {
    failoverState.successfulRequests++;
  } else {
    if (healthiest && healthiest !== failoverState.httpPrimary) {
      const from = failoverState.httpPrimary;
      const failoverStart = Date.now();
      failoverState.httpPrimary = healthiest;
      failoverState.totalFailovers++;

      // Update primary for rpc-tester DB tagging
      setCurrentPrimary(healthiest);

      const retryUrl = getEndpointUrl(healthiest);
      let recoveryTimeMs = null;
      if (retryUrl) {
        const retry = await simulateRequest(retryUrl);
        if (retry.success) {
          failoverState.successfulRequests++;
          recoveryTimeMs = Date.now() - failoverStart;
        }
      }

      const httpEvent = {
        timestamp: Date.now(),
        type: "http",
        from,
        to: healthiest,
        reason: result.reason || "request failed",
        recovery_time_ms: recoveryTimeMs,
      };
      failoverState.failoverLog.push(httpEvent);
      try { writeFailoverEvent(httpEvent); } catch {}

      if (failoverState.failoverLog.length > 50) {
        failoverState.failoverLog.shift();
      }
    }
  }

  failoverState.uptimeWithFailover =
    failoverState.totalRequests > 0
      ? Math.round((failoverState.successfulRequests / failoverState.totalRequests) * 10000) / 100
      : 100;
}

function startFailoverSimulator() {
  // Restore persisted failover events from SQLite so they survive restarts
  try {
    const persisted = getRecentFailoverEvents(50);
    if (persisted.length > 0) {
      // persisted comes newest-first, reverse to chronological order
      failoverState.failoverLog = persisted.reverse();
      failoverState.totalFailovers = persisted.filter((e) => e.type === "http").length;
      console.log(`  Restored ${persisted.length} failover events from database`);
    }
  } catch (err) {
    console.error("  Failed to restore failover events:", err.message);
  }

  failoverInterval = setInterval(failoverTick, FAILOVER_POLL_INTERVAL);
}

function getFailoverStatus() {
  // Get current HTTP primary stats
  const allStats = getAllStats();
  const httpPrimaryStats = allStats.find((e) => e.name === failoverState.httpPrimary);

  // Get current WS primary stats
  const wsStatuses = getAllWsStatus();
  const wsPrimaryStats = wsStatuses.find((w) => w.name === failoverState.wsPrimary);

  return {
    httpPrimary: failoverState.httpPrimary,
    httpPrimaryLatency: httpPrimaryStats?.stats?.avgLatency || null,
    wsPrimary: failoverState.wsPrimary,
    wsPrimaryUptime: wsPrimaryStats?.connectionUptime || null,
    wsPrimaryConnectedAt: wsPrimaryStats?.connectedAt || null,
    failoverLog: failoverState.failoverLog,
    totalFailovers: failoverState.totalFailovers,
    totalRequests: failoverState.totalRequests,
    successfulRequests: failoverState.successfulRequests,
    uptimeWithFailover: failoverState.uptimeWithFailover,
  };
}

function stopFailoverSimulator() {
  if (failoverInterval) {
    clearInterval(failoverInterval);
    failoverInterval = null;
  }
}

module.exports = {
  startFailoverSimulator,
  getFailoverStatus,
  stopFailoverSimulator,
};
