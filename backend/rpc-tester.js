const { RPC_ENDPOINTS, TEST_ACCOUNT, HTTP_TIMEOUT, RESULTS_WINDOW } = require("./config");

// In-memory store: { [endpointName]: { results: [], stats: {} } }
const endpointData = new Map();

function initEndpointData() {
  for (const ep of RPC_ENDPOINTS) {
    endpointData.set(ep.name, {
      name: ep.name,
      results: [],
      stats: {
        avgLatency: 0,
        p99Latency: 0,
        successRate: 100,
        currentSlot: 0,
        slotDrift: 0,
        isHealthy: true,
        consecutiveFailures: 0,
      },
    });
  }
}

async function rpcPost(url, method, params = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT);

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    const latency = Date.now() - start;

    if (res.status === 429) {
      return { latency, success: false, rateLimited: true, data: null };
    }

    const data = await res.json();
    if (data.error) {
      return { latency, success: false, rateLimited: false, data: null, error: data.error.message };
    }

    return { latency, success: true, rateLimited: false, data: data.result };
  } catch (err) {
    const latency = Date.now() - start;
    return { latency, success: false, rateLimited: false, data: null, error: err.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function testEndpoint(endpoint) {
  const [healthResult, slotResult, accountResult] = await Promise.all([
    rpcPost(endpoint.http, "getHealth"),
    rpcPost(endpoint.http, "getSlot"),
    rpcPost(endpoint.http, "getAccountInfo", [TEST_ACCOUNT, { encoding: "base64" }]),
  ]);

  return {
    timestamp: Date.now(),
    getHealth: {
      latency: healthResult.latency,
      success: healthResult.success,
      rateLimited: healthResult.rateLimited,
    },
    getSlot: {
      latency: slotResult.latency,
      slot: slotResult.data || 0,
      success: slotResult.success,
      rateLimited: slotResult.rateLimited,
    },
    getAccountInfo: {
      latency: accountResult.latency,
      success: accountResult.success,
      rateLimited: accountResult.rateLimited,
      dataSize: accountResult.data?.value?.data?.[0]?.length || 0,
    },
  };
}

function computeStats(data) {
  const results = data.results;
  if (results.length === 0) {
    return data.stats;
  }

  // Collect all latencies from successful results
  const latencies = [];
  let successCount = 0;
  let totalTests = 0;

  for (const r of results) {
    for (const test of ["getHealth", "getSlot", "getAccountInfo"]) {
      totalTests++;
      if (r[test].success) {
        successCount++;
        latencies.push(r[test].latency);
      }
    }
  }

  latencies.sort((a, b) => a - b);

  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  const p99Index = Math.max(0, Math.ceil(latencies.length * 0.99) - 1);
  const p99Latency = latencies.length > 0 ? latencies[p99Index] : 0;

  const successRate = totalTests > 0
    ? Math.round((successCount / totalTests) * 1000) / 10
    : 0;

  const lastResult = results[results.length - 1];
  const currentSlot = lastResult.getSlot.slot || 0;

  // Consecutive failures: count from most recent backward
  let consecutiveFailures = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    const allFailed = !r.getHealth.success && !r.getSlot.success && !r.getAccountInfo.success;
    if (allFailed) {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  // Health determination
  const isHealthy = !(
    consecutiveFailures >= 3 ||
    avgLatency > 2000 ||
    successRate < 90 ||
    data.stats.slotDrift > 10
  );

  data.stats = {
    avgLatency,
    p99Latency,
    successRate,
    currentSlot,
    slotDrift: data.stats.slotDrift, // updated separately
    isHealthy,
    consecutiveFailures,
  };

  return data.stats;
}

function updateSlotDrift() {
  let maxSlot = 0;
  for (const [, data] of endpointData) {
    if (data.stats.currentSlot > maxSlot) {
      maxSlot = data.stats.currentSlot;
    }
  }

  for (const [, data] of endpointData) {
    data.stats.slotDrift = data.stats.currentSlot > 0
      ? maxSlot - data.stats.currentSlot
      : 0;

    // Re-check health after slot drift update
    if (data.stats.slotDrift > 10) {
      data.stats.isHealthy = false;
    }
  }
}

async function runHealthCheck() {
  const promises = RPC_ENDPOINTS.map(async (endpoint) => {
    const result = await testEndpoint(endpoint);
    const data = endpointData.get(endpoint.name);
    if (!data) return;

    data.results.push(result);
    if (data.results.length > RESULTS_WINDOW) {
      data.results.shift();
    }

    computeStats(data);
  });

  await Promise.all(promises);
  updateSlotDrift();
}

function getAllStats() {
  const stats = [];
  for (const [name, data] of endpointData) {
    stats.push({
      name,
      stats: data.stats,
      latestResult: data.results[data.results.length - 1] || null,
      resultCount: data.results.length,
    });
  }
  return stats;
}

function getHealthiestEndpoint() {
  let best = null;
  let bestScore = -Infinity;

  for (const [name, data] of endpointData) {
    if (!data.stats.isHealthy) continue;

    // Score: higher is better. Prioritize success rate, then latency
    const score = data.stats.successRate * 10 - data.stats.avgLatency - data.stats.slotDrift * 100;
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }

  // If nothing is healthy, return the one with fewest consecutive failures
  if (!best) {
    let minFailures = Infinity;
    for (const [name, data] of endpointData) {
      if (data.stats.consecutiveFailures < minFailures) {
        minFailures = data.stats.consecutiveFailures;
        best = name;
      }
    }
  }

  return best;
}

function getEndpointUrl(name) {
  const ep = RPC_ENDPOINTS.find((e) => e.name === name);
  return ep ? ep.http : null;
}

function getLatencyHistory() {
  const history = [];
  // Build time-aligned series
  for (const [name, data] of endpointData) {
    for (const r of data.results) {
      const avgLatency = Math.round(
        [r.getHealth.latency, r.getSlot.latency, r.getAccountInfo.latency]
          .filter((l) => l > 0)
          .reduce((a, b, _, arr) => a + b / arr.length, 0)
      );
      history.push({
        name,
        timestamp: r.timestamp,
        avgLatency,
      });
    }
  }
  return history;
}

module.exports = {
  initEndpointData,
  runHealthCheck,
  getAllStats,
  getHealthiestEndpoint,
  getEndpointUrl,
  getLatencyHistory,
  endpointData,
};
