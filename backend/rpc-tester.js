const { RPC_ENDPOINTS, TEST_ACCOUNT, HTTP_TIMEOUT, RESULTS_WINDOW, getNextPool } = require("./config");
const { writeHealthCheck, writeRawAccountData, writeRawSlotData } = require("./database");

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

async function testEndpoint(endpoint, pool) {
  const [healthResult, slotResult, accountResult] = await Promise.all([
    rpcPost(endpoint.http, "getHealth"),
    rpcPost(endpoint.http, "getSlot"),
    rpcPost(endpoint.http, "getAccountInfo", [pool.address, { encoding: "base64" }]),
  ]);

  return {
    timestamp: Date.now(),
    pool,
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
      // Keep raw response for DB storage
      _rawResponse: accountResult,
    },
  };
}

function computeStats(data) {
  const results = data.results;
  if (results.length === 0) {
    return data.stats;
  }

  // Use last 60 results for stats (5-minute window)
  const recentResults = results.slice(-60);

  const latencies = [];
  let successCount = 0;
  let totalTests = 0;

  for (const r of recentResults) {
    for (const test of ["getHealth", "getSlot", "getAccountInfo"]) {
      // Skip rate-limited (429) responses — they don't indicate endpoint failure,
      // just that we exceeded the rate limit. Don't count them for or against.
      if (r[test].rateLimited) continue;
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

  let consecutiveFailures = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    // Rate-limited (429) is not an endpoint failure — skip it
    const allFailed = !r.getHealth.success && !r.getSlot.success && !r.getAccountInfo.success
      && !r.getHealth.rateLimited && !r.getSlot.rateLimited && !r.getAccountInfo.rateLimited;
    if (allFailed) {
      consecutiveFailures++;
    } else {
      break;
    }
  }

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
    slotDrift: data.stats.slotDrift,
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

    if (data.stats.slotDrift > 10) {
      data.stats.isHealthy = false;
    }
  }
}

// Track current primary for DB tagging
let _currentPrimary = null;
function setCurrentPrimary(name) {
  _currentPrimary = name;
}

async function runHealthCheck() {
  // Pick the pool for this cycle (all endpoints test the same pool)
  const pool = getNextPool();

  const promises = RPC_ENDPOINTS.map(async (endpoint) => {
    const result = await testEndpoint(endpoint, pool);
    const data = endpointData.get(endpoint.name);
    if (!data) return;

    data.results.push(result);
    if (data.results.length > RESULTS_WINDOW) {
      data.results.shift();
    }

    computeStats(data);

    // Write to SQLite
    try {
      const isPrimary = _currentPrimary === endpoint.name;
      writeHealthCheck(endpoint.name, result, data.stats.slotDrift, isPrimary);

      // Write raw slot data from all endpoints
      if (result.getSlot.success && result.getSlot.slot) {
        writeRawSlotData(endpoint.name, result.getSlot.slot);
      }

      // Write raw account data only from primary (avoid duplicates)
      // Note: Pool parsing (Part A) is now handled by the scheduler module
      if (isPrimary && result.getAccountInfo._rawResponse) {
        writeRawAccountData(
          endpoint.name,
          pool,
          result.getAccountInfo._rawResponse
        );
      }
    } catch (err) {
      // Don't let DB errors crash health checks
      console.error(`DB write error for ${endpoint.name}:`, err.message);
    }
  });

  await Promise.all(promises);
  updateSlotDrift();
}

function getAllStats() {
  const stats = [];
  for (const [name, data] of endpointData) {
    const ep = RPC_ENDPOINTS.find((e) => e.name === name);
    const lastResult = data.results[data.results.length - 1] || null;
    // Strip _rawResponse to avoid sending huge base64 data to frontend
    let sanitizedResult = null;
    if (lastResult) {
      const { getAccountInfo, ...rest } = lastResult;
      const { _rawResponse, ...acctRest } = getAccountInfo;
      sanitizedResult = { ...rest, getAccountInfo: acctRest };
    }
    stats.push({
      name,
      stats: data.stats,
      latestResult: sanitizedResult,
      resultCount: data.results.length,
      description: ep?.description || "",
      details: ep?.details || null,
      info: ep?.info || null,
      wsSupported: !!ep?.ws,
    });
  }
  return stats;
}

function getHealthiestEndpoint() {
  let best = null;
  let bestScore = -Infinity;

  for (const [name, data] of endpointData) {
    if (!data.stats.isHealthy) continue;

    const score = data.stats.successRate * 10 - data.stats.avgLatency - data.stats.slotDrift * 100;
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }

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

function getLatencyHistory(sinceMs) {
  const history = [];
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;

  for (const [name, data] of endpointData) {
    for (const r of data.results) {
      if (r.timestamp < cutoff) continue;

      const successfulLatencies = [r.getHealth, r.getSlot, r.getAccountInfo]
        .filter((t) => t.success)
        .map((t) => t.latency);

      if (successfulLatencies.length === 0) {
        // Endpoint was DOWN — push null so frontend can show a gap
        history.push({ name, timestamp: r.timestamp, avgLatency: null });
      } else {
        const avgLatency = Math.round(
          successfulLatencies.reduce((a, b) => a + b, 0) / successfulLatencies.length
        );
        history.push({ name, timestamp: r.timestamp, avgLatency });
      }
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
  setCurrentPrimary,
  endpointData,
};
