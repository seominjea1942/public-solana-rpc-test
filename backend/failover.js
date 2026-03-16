const { RPC_ENDPOINTS, TEST_ACCOUNT, HTTP_TIMEOUT, FAILOVER_POLL_INTERVAL } = require("./config");
const { getHealthiestEndpoint, getEndpointUrl } = require("./rpc-tester");

const failoverState = {
  currentPrimary: null,
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

async function failoverTick() {
  // Pick the healthiest RPC
  const healthiest = getHealthiestEndpoint();

  // Initialize primary if not set
  if (!failoverState.currentPrimary) {
    failoverState.currentPrimary = healthiest || RPC_ENDPOINTS[0].name;
  }

  const primaryUrl = getEndpointUrl(failoverState.currentPrimary);
  if (!primaryUrl) return;

  failoverState.totalRequests++;

  const result = await simulateRequest(primaryUrl);

  if (result.success) {
    failoverState.successfulRequests++;
  } else {
    // Primary failed — try to failover
    if (healthiest && healthiest !== failoverState.currentPrimary) {
      const from = failoverState.currentPrimary;
      failoverState.currentPrimary = healthiest;
      failoverState.totalFailovers++;

      const entry = {
        timestamp: Date.now(),
        from,
        to: healthiest,
        reason: result.reason || "request failed",
      };
      failoverState.failoverLog.push(entry);

      // Keep only last 50 entries
      if (failoverState.failoverLog.length > 50) {
        failoverState.failoverLog.shift();
      }

      // Try again with new primary
      const retryUrl = getEndpointUrl(healthiest);
      if (retryUrl) {
        const retry = await simulateRequest(retryUrl);
        if (retry.success) {
          failoverState.successfulRequests++;
        }
      }
    }
  }

  // Also check if healthiest has changed and current primary should be swapped proactively
  if (
    healthiest &&
    healthiest !== failoverState.currentPrimary &&
    result.success
  ) {
    // Current primary is still working, but a healthier option is available
    // Only swap proactively if current primary is showing signs of degradation
    const currentUrl = getEndpointUrl(failoverState.currentPrimary);
    // Don't proactively swap to avoid flapping — only swap on failure
  }

  // Update uptime
  failoverState.uptimeWithFailover =
    failoverState.totalRequests > 0
      ? Math.round((failoverState.successfulRequests / failoverState.totalRequests) * 10000) / 100
      : 100;
}

function startFailoverSimulator() {
  failoverInterval = setInterval(failoverTick, FAILOVER_POLL_INTERVAL);
}

function getFailoverStatus() {
  return {
    currentPrimary: failoverState.currentPrimary,
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
