const { POOL_ACCOUNTS } = require("./config");
const { rateLimitedRpcPost, limiter } = require("./rate-limiter");
const { parseRaydiumAmmV4 } = require("./pool-parser");
const { runTxMonitor } = require("./tx-monitor");
const { maybeValidate } = require("./price-validator");
const {
  writeRawAccountData,
  writeParsedPoolData,
  writeSchedulerLog,
  writeRateLimitLog,
} = require("./database");

// ── Schedule definition ──
// [secondOffset, taskType, poolIndex]
// 30-second cycle: Part B (txMonitor) and Part A (poolState) staggered
const SCHEDULE = [
  { offset: 0,  task: "txMonitor", poolIdx: 0 },  // Part B: Raydium AMM v4
  { offset: 5,  task: "poolState", poolIdx: 0 },  // Part A: Raydium AMM v4
  { offset: 8,  task: "txMonitor", poolIdx: 1 },  // Part B: Raydium CPMM
  { offset: 13, task: "poolState", poolIdx: 1 },  // Part A: Raydium CPMM
  { offset: 15, task: "txMonitor", poolIdx: 2 },  // Part B: Orca Whirlpool
  { offset: 20, task: "poolState", poolIdx: 2 },  // Part A: Orca Whirlpool
  { offset: 23, task: "txMonitor", poolIdx: 3 },  // Part B: Meteora DLMM
  { offset: 28, task: "poolState", poolIdx: 3 },  // Part A: Meteora DLMM
];

const BASE_CYCLE_DURATION = 30000; // 30 seconds
const MAX_CYCLE_DURATION = 45000;  // 45 seconds (degraded mode)

// ── State ──
let cycleNumber = 0;
let schedulerStartTime = null;
let currentCycleDuration = BASE_CYCLE_DURATION;
let cycleInterval = null;
let rateLimitLogInterval = null;
let _getPrimaryUrl = null;

// Overlap protection: track running tasks by key
const runningTasks = new Set();

// Per-task status for real-time UI
const taskStatus = new Map();

function initTaskStatus() {
  for (const entry of SCHEDULE) {
    const pool = POOL_ACCOUNTS[entry.poolIdx];
    if (!pool) continue;
    const key = `${entry.task}:${pool.address}`;
    taskStatus.set(key, {
      task: entry.task,
      pool: pool.label,
      poolAddress: pool.address,
      dex: pool.dex,
      poolType: pool.poolType,
      lastRun: null,
      lastDurationMs: null,
      lastStatus: "pending",
      itemsProcessed: 0,
      rpcCalls: 0,
      lastError: null,
    });
  }
}

// ── Task execution with overlap protection ──

async function executeTask(taskKey, fn) {
  if (runningTasks.has(taskKey)) {
    console.warn(`[Scheduler] Skipping ${taskKey} — previous run still in progress`);
    const status = taskStatus.get(taskKey);
    if (status) status.lastStatus = "skipped";
    return;
  }

  runningTasks.add(taskKey);
  const start = Date.now();
  const status = taskStatus.get(taskKey);

  try {
    const result = await fn();
    const durationMs = Date.now() - start;

    if (status) {
      status.lastRun = Date.now();
      status.lastDurationMs = durationMs;
      status.lastStatus = result.success ? "ok" : "error";
      status.itemsProcessed = result.itemsProcessed || 0;
      status.rpcCalls = result.rpcCalls || 0;
      status.lastError = result.error || null;
    }

    // Log to DB
    try {
      const pool = getPoolForKey(taskKey);
      writeSchedulerLog({
        timestamp: Date.now(),
        task: taskKey.split(":")[0],
        poolAddress: pool?.address || "",
        poolLabel: pool?.label || "",
        durationMs,
        rpcCallsMade: result.rpcCalls || 0,
        itemsProcessed: result.itemsProcessed || 0,
        success: result.success ? 1 : 0,
        error: result.error || null,
      });
    } catch {}

    return result;
  } catch (err) {
    const durationMs = Date.now() - start;

    if (status) {
      status.lastRun = Date.now();
      status.lastDurationMs = durationMs;
      status.lastStatus = "error";
      status.lastError = err.message;
    }

    try {
      const pool = getPoolForKey(taskKey);
      writeSchedulerLog({
        timestamp: Date.now(),
        task: taskKey.split(":")[0],
        poolAddress: pool?.address || "",
        poolLabel: pool?.label || "",
        durationMs,
        rpcCallsMade: 0,
        itemsProcessed: 0,
        success: 0,
        error: err.message,
      });
    } catch {}

    console.error(`[Scheduler] ${taskKey} failed:`, err.message);
  } finally {
    runningTasks.delete(taskKey);
  }
}

function getPoolForKey(taskKey) {
  const addr = taskKey.split(":")[1];
  return POOL_ACCOUNTS.find((p) => p.address === addr) || null;
}

// ── Part A — Pool State Parser ──

async function runPoolStateTask(pool) {
  const rpcUrl = _getPrimaryUrl();
  if (!rpcUrl) return { success: false, error: "No primary URL", rpcCalls: 0, itemsProcessed: 0 };

  let rpcCalls = 0;

  // 1. Fetch account data via rate limiter
  const accountResult = await rateLimitedRpcPost(rpcUrl, "getAccountInfo", [
    pool.address,
    { encoding: "base64" },
  ]);
  rpcCalls++;

  // Save raw account data to DB
  try {
    writeRawAccountData("scheduler", pool, accountResult);
  } catch (err) {
    console.error(`[Scheduler] Raw data write error for ${pool.label}:`, err.message);
  }

  if (!accountResult.success) {
    return { success: false, error: accountResult.error, rpcCalls, itemsProcessed: 0 };
  }

  // 2. If AMM v4, decode + fetch vault balances + calculate price
  if (pool.poolType === "AMM v4") {
    const base64Data = accountResult.data?.value?.data?.[0];
    const slot = accountResult.data?.context?.slot;
    if (base64Data) {
      try {
        const parsed = await parseRaydiumAmmV4(rpcUrl, base64Data, slot);
        rpcCalls += 2; // vault balance queries
        writeParsedPoolData(pool.address, pool.label, parsed);

        // Validate price against DexScreener (rate-limited: once per 5 min per pool)
        if (parsed.price > 0) {
          maybeValidate(
            { address: pool.address, label: pool.label, dex: pool.dex, poolType: pool.poolType, baseMint: parsed.baseMint },
            parsed.price
          ).catch(() => {}); // fire-and-forget, don't block the pipeline
        }

        return { success: true, rpcCalls, itemsProcessed: 1 };
      } catch (err) {
        try {
          writeParsedPoolData(pool.address, pool.label, {
            parseSuccess: false,
            error: err.message,
          });
        } catch {}
        return { success: false, error: err.message, rpcCalls, itemsProcessed: 0 };
      }
    }
  }

  // Non-AMM v4: just collected raw data, no parsing yet
  return { success: true, rpcCalls, itemsProcessed: 1 };
}

// ── Part B — Transaction Monitor ──

async function runTxMonitorTask(pool) {
  const rpcUrl = _getPrimaryUrl();
  if (!rpcUrl) return { success: false, error: "No primary URL", rpcCalls: 0, itemsProcessed: 0 };

  const result = await runTxMonitor(pool, rpcUrl);
  return {
    success: result.success,
    error: result.error || null,
    rpcCalls: result.rpcCalls,
    itemsProcessed: result.newTxCount || 0,
  };
}

// ── Cycle execution ──

function runCycle() {
  cycleNumber++;

  const rpcUrl = _getPrimaryUrl();
  if (!rpcUrl) {
    console.warn("[Scheduler] No primary RPC URL available, skipping cycle");
    return;
  }

  for (const entry of SCHEDULE) {
    const pool = POOL_ACCOUNTS[entry.poolIdx];
    if (!pool) continue;

    const taskKey = `${entry.task}:${pool.address}`;
    const delay = entry.offset * 1000;

    // Use setTimeout with absolute offset from cycle start (not sequential awaits)
    setTimeout(() => {
      if (entry.task === "poolState") {
        executeTask(taskKey, () => runPoolStateTask(pool));
      } else if (entry.task === "txMonitor") {
        executeTask(taskKey, () => runTxMonitorTask(pool));
      }
    }, delay);
  }
}

// ── Graceful degradation ──

let _prev429Count = 0;

function checkDegradation() {
  const stats = limiter.getStats();

  // If we got NEW 429s or rate is close to limit, slow down
  if (stats.total429s > _prev429Count || stats.currentReqPerSec > 7) {
    _prev429Count = stats.total429s;
    if (currentCycleDuration < MAX_CYCLE_DURATION) {
      currentCycleDuration = MAX_CYCLE_DURATION;
      console.warn(`[Scheduler] Degradation: extending cycle to ${currentCycleDuration / 1000}s`);
      restartCycleInterval();
    }
  } else if (currentCycleDuration > BASE_CYCLE_DURATION && stats.currentReqPerSec < 4) {
    // Things stabilized, go back to normal
    currentCycleDuration = BASE_CYCLE_DURATION;
    console.log(`[Scheduler] Recovered: cycle back to ${currentCycleDuration / 1000}s`);
    restartCycleInterval();
  }
}

function restartCycleInterval() {
  if (cycleInterval) clearInterval(cycleInterval);
  cycleInterval = setInterval(() => {
    checkDegradation();
    runCycle();
  }, currentCycleDuration);
}

// ── Public API ──

function startScheduler(getPrimaryUrl) {
  _getPrimaryUrl = getPrimaryUrl;
  schedulerStartTime = Date.now();
  initTaskStatus();

  console.log(`[Scheduler] Starting with ${SCHEDULE.length} tasks in ${currentCycleDuration / 1000}s cycles`);
  console.log(`[Scheduler] Rate limiter: ${limiter.maxPerSecond} req/sec max`);

  // Wait 10 seconds for health checks / failover to establish a primary
  setTimeout(() => {
    // First cycle
    runCycle();
    // Then repeat
    cycleInterval = setInterval(() => {
      checkDegradation();
      runCycle();
    }, currentCycleDuration);
  }, 10000);

  // Log rate limit stats every 10 seconds
  rateLimitLogInterval = setInterval(() => {
    const stats = limiter.getStats();
    try {
      writeRateLimitLog({
        timestamp: Date.now(),
        requestsPerSec: stats.currentReqPerSec,
        tokensRemaining: stats.tokensRemaining,
        wasThrottled: stats.throttledCount > 0 ? 1 : 0,
        got429: stats.total429s > 0 ? 1 : 0,
      });
    } catch {}
  }, 10000);
}

function stopScheduler() {
  if (cycleInterval) clearInterval(cycleInterval);
  if (rateLimitLogInterval) clearInterval(rateLimitLogInterval);
  cycleInterval = null;
  rateLimitLogInterval = null;
  console.log("[Scheduler] Stopped");
}

function getSchedulerStatus() {
  const uptime = schedulerStartTime ? Date.now() - schedulerStartTime : 0;
  const hours = Math.floor(uptime / 3600000);
  const mins = Math.floor((uptime % 3600000) / 60000);
  const secs = Math.floor((uptime % 60000) / 1000);

  const tasks = [];
  for (const [, status] of taskStatus) {
    tasks.push({ ...status });
  }

  return {
    cycleNumber,
    cycleDuration: currentCycleDuration / 1000,
    baseCycleDuration: BASE_CYCLE_DURATION / 1000,
    isDegraded: currentCycleDuration > BASE_CYCLE_DURATION,
    uptime: `${hours > 0 ? hours + "h " : ""}${mins}m ${secs}s`,
    uptimeMs: uptime,
    tasks,
    rateLimit: limiter.getStats(),
  };
}

module.exports = { startScheduler, stopScheduler, getSchedulerStatus };
