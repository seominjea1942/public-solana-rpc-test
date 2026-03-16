const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "rpc-data.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma("journal_mode = WAL");

// ── Table creation ──

db.exec(`
  CREATE TABLE IF NOT EXISTS health_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    endpoint_name TEXT NOT NULL,
    get_health_latency INTEGER,
    get_health_success INTEGER NOT NULL,
    get_slot_latency INTEGER,
    get_slot_success INTEGER NOT NULL,
    get_slot_value INTEGER,
    slot_drift INTEGER,
    get_account_latency INTEGER,
    get_account_success INTEGER NOT NULL,
    rate_limited INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    was_primary INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS failover_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    from_endpoint TEXT NOT NULL,
    to_endpoint TEXT NOT NULL,
    reason TEXT NOT NULL,
    type TEXT,
    recovery_time_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS ws_connection_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    endpoint_name TEXT NOT NULL,
    event TEXT NOT NULL,
    duration_ms INTEGER,
    detail TEXT
  );

  CREATE TABLE IF NOT EXISTS uptime_summary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    endpoint_name TEXT NOT NULL,
    total_checks INTEGER,
    successful_checks INTEGER,
    success_rate REAL,
    avg_latency REAL,
    p50_latency REAL,
    p99_latency REAL,
    max_latency INTEGER,
    rate_limit_count INTEGER,
    ws_connected_seconds INTEGER,
    ws_disconnected_seconds INTEGER,
    ws_uptime_pct REAL,
    ws_disconnect_count INTEGER
  );

  CREATE TABLE IF NOT EXISTS raw_account_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    endpoint_name TEXT NOT NULL,
    account_address TEXT NOT NULL,
    pool_label TEXT,
    dex TEXT,
    pool_type TEXT,
    program_id TEXT,
    slot INTEGER,
    data_base64 TEXT,
    data_size INTEGER,
    lamports INTEGER,
    owner_program TEXT,
    success INTEGER NOT NULL,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS raw_slot_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    endpoint_name TEXT NOT NULL,
    slot_number INTEGER NOT NULL,
    block_time INTEGER
  );

  CREATE TABLE IF NOT EXISTS parsed_pool_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    pool_address TEXT NOT NULL,
    pool_label TEXT,
    base_mint TEXT,
    quote_mint TEXT,
    lp_mint TEXT,
    base_vault TEXT,
    quote_vault TEXT,
    base_decimal INTEGER,
    quote_decimal INTEGER,
    base_amount REAL,
    quote_amount REAL,
    base_amount_raw TEXT,
    quote_amount_raw TEXT,
    price REAL,
    liquidity_usd REAL,
    fee_rate REAL,
    status INTEGER,
    lp_reserve TEXT,
    open_orders TEXT,
    market_id TEXT,
    slot INTEGER,
    parse_success INTEGER NOT NULL,
    error_message TEXT
  );
`);

// ── Schema migration: add new columns to existing tables ──
const colsToAdd = [
  ["raw_account_data", "dex", "TEXT"],
  ["raw_account_data", "pool_type", "TEXT"],
  ["raw_account_data", "program_id", "TEXT"],
];
for (const [table, col, type] of colsToAdd) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch {
    // Column already exists — ignore
  }
}

// ── Indexes ──

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_hc_ts ON health_checks(timestamp);
  CREATE INDEX IF NOT EXISTS idx_hc_ep_ts ON health_checks(endpoint_name, timestamp);
  CREATE INDEX IF NOT EXISTS idx_fo_ts ON failover_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_ws_ts ON ws_connection_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_us_ts ON uptime_summary(window_start);
  CREATE INDEX IF NOT EXISTS idx_rad_ts ON raw_account_data(timestamp);
  CREATE INDEX IF NOT EXISTS idx_rad_addr ON raw_account_data(account_address, timestamp);
  CREATE INDEX IF NOT EXISTS idx_rsd_ts ON raw_slot_data(timestamp);
  CREATE INDEX IF NOT EXISTS idx_ppd_ts ON parsed_pool_data(timestamp);
  CREATE INDEX IF NOT EXISTS idx_ppd_addr_ts ON parsed_pool_data(pool_address, timestamp);
`);

// ── Prepared statements ──

const insertHealthCheck = db.prepare(`
  INSERT INTO health_checks
    (timestamp, endpoint_name, get_health_latency, get_health_success,
     get_slot_latency, get_slot_success, get_slot_value, slot_drift,
     get_account_latency, get_account_success, rate_limited, error_message, was_primary)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertFailoverEvent = db.prepare(`
  INSERT INTO failover_events (timestamp, from_endpoint, to_endpoint, reason, type, recovery_time_ms)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertWsLog = db.prepare(`
  INSERT INTO ws_connection_log (timestamp, endpoint_name, event, duration_ms, detail)
  VALUES (?, ?, ?, ?, ?)
`);

const insertUptimeSummary = db.prepare(`
  INSERT INTO uptime_summary
    (window_start, window_end, endpoint_name, total_checks, successful_checks,
     success_rate, avg_latency, p50_latency, p99_latency, max_latency,
     rate_limit_count, ws_connected_seconds, ws_disconnected_seconds,
     ws_uptime_pct, ws_disconnect_count)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertRawAccountData = db.prepare(`
  INSERT INTO raw_account_data
    (timestamp, endpoint_name, account_address, pool_label, dex, pool_type, program_id,
     slot, data_base64, data_size, lamports, owner_program, success, error_message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertRawSlotData = db.prepare(`
  INSERT INTO raw_slot_data (timestamp, endpoint_name, slot_number, block_time)
  VALUES (?, ?, ?, ?)
`);

const insertParsedPoolData = db.prepare(`
  INSERT INTO parsed_pool_data
    (timestamp, pool_address, pool_label, base_mint, quote_mint, lp_mint,
     base_vault, quote_vault, base_decimal, quote_decimal,
     base_amount, quote_amount, base_amount_raw, quote_amount_raw,
     price, liquidity_usd, fee_rate, status, lp_reserve,
     open_orders, market_id, slot, parse_success, error_message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// ── Write helpers ──

function writeHealthCheck(endpointName, result, slotDrift, isPrimary) {
  const errors = [];
  for (const test of ["getHealth", "getSlot", "getAccountInfo"]) {
    if (!result[test].success && result[test].error) {
      errors.push(`${test}: ${result[test].error}`);
    }
  }
  const rateLimited = result.getHealth.rateLimited || result.getSlot.rateLimited || result.getAccountInfo.rateLimited;

  insertHealthCheck.run(
    result.timestamp,
    endpointName,
    result.getHealth.latency,
    result.getHealth.success ? 1 : 0,
    result.getSlot.latency,
    result.getSlot.success ? 1 : 0,
    result.getSlot.slot || null,
    slotDrift || 0,
    result.getAccountInfo.latency,
    result.getAccountInfo.success ? 1 : 0,
    rateLimited ? 1 : 0,
    errors.length > 0 ? errors.join("; ") : null,
    isPrimary ? 1 : 0
  );
}

function writeFailoverEvent(event) {
  insertFailoverEvent.run(
    event.timestamp,
    event.from,
    event.to,
    event.reason,
    event.type || null,
    event.recovery_time_ms || null
  );
}

function writeWsLog(endpointName, event, durationMs, detail) {
  insertWsLog.run(Date.now(), endpointName, event, durationMs || null, detail || null);
}

function writeRawAccountData(endpointName, pool, response) {
  if (response.success && response.data?.value) {
    const val = response.data.value;
    insertRawAccountData.run(
      Date.now(),
      endpointName,
      pool.address,
      pool.label,
      pool.dex || null,
      pool.poolType || null,
      pool.programId || null,
      response.data.context?.slot || null,
      val.data?.[0] || null,
      val.data?.[0]?.length || 0,
      val.lamports || 0,
      val.owner || null,
      1,
      null
    );
  } else {
    insertRawAccountData.run(
      Date.now(),
      endpointName,
      pool.address,
      pool.label,
      pool.dex || null,
      pool.poolType || null,
      pool.programId || null,
      null, null, 0, 0, null,
      0,
      response.error || "unknown error"
    );
  }
}

function writeRawSlotData(endpointName, slotNumber) {
  insertRawSlotData.run(Date.now(), endpointName, slotNumber, null);
}

function writeParsedPoolData(poolAddress, poolLabel, parsed) {
  if (parsed.parseSuccess) {
    insertParsedPoolData.run(
      Date.now(), poolAddress, poolLabel,
      parsed.baseMint, parsed.quoteMint, parsed.lpMint,
      parsed.baseVault, parsed.quoteVault,
      parsed.baseDecimal, parsed.quoteDecimal,
      parsed.baseAmount, parsed.quoteAmount,
      parsed.baseAmountRaw, parsed.quoteAmountRaw,
      parsed.price, parsed.liquidityUsd, parsed.feeRate,
      parsed.status, parsed.lpReserve,
      parsed.openOrders, parsed.marketId,
      parsed.slot || null, 1, null
    );
  } else {
    insertParsedPoolData.run(
      Date.now(), poolAddress, poolLabel,
      null, null, null, null, null, null, null,
      null, null, null, null, null, null, null,
      null, null, null, null, null,
      0, parsed.error || "unknown error"
    );
  }
}

// ── Aggregation: uptime_summary every 5 minutes ──

function aggregateUptimeSummary(windowStart, windowEnd, endpointName, wsStatus) {
  const rows = db.prepare(`
    SELECT * FROM health_checks
    WHERE endpoint_name = ? AND timestamp >= ? AND timestamp < ?
  `).all(endpointName, windowStart, windowEnd);

  if (rows.length === 0) return;

  let successCount = 0;
  let rateLimitCount = 0;
  const latencies = [];

  for (const row of rows) {
    const checks = [
      { success: row.get_health_success, latency: row.get_health_latency },
      { success: row.get_slot_success, latency: row.get_slot_latency },
      { success: row.get_account_success, latency: row.get_account_latency },
    ];
    let allSuccess = true;
    for (const c of checks) {
      if (c.success && c.latency != null) latencies.push(c.latency);
      if (!c.success) allSuccess = false;
    }
    if (allSuccess) successCount++;
    if (row.rate_limited) rateLimitCount++;
  }

  latencies.sort((a, b) => a - b);
  const avgLat = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p50Lat = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p99Lat = latencies.length > 0 ? latencies[Math.max(0, Math.ceil(latencies.length * 0.99) - 1)] : 0;
  const maxLat = latencies.length > 0 ? latencies[latencies.length - 1] : 0;
  const successRate = rows.length > 0 ? (successCount / rows.length) * 100 : 0;

  // WS stats from ws_connection_log
  const wsLogs = db.prepare(`
    SELECT * FROM ws_connection_log
    WHERE endpoint_name = ? AND timestamp >= ? AND timestamp < ?
  `).all(endpointName, windowStart, windowEnd);

  let wsDisconnects = 0;
  let wsConnectedSec = 0;
  for (const log of wsLogs) {
    if (log.event === "disconnected" || log.event === "heartbeat_timeout") {
      wsDisconnects++;
      if (log.duration_ms) wsConnectedSec += log.duration_ms / 1000;
    }
  }

  const windowSec = (windowEnd - windowStart) / 1000;
  // Use live wsStatus for uptime if available, otherwise estimate from logs
  let wsUptimePct = null;
  if (wsStatus) {
    wsUptimePct = wsStatus.connectionUptime || 0;
  } else if (windowSec > 0) {
    wsUptimePct = Math.min(100, (wsConnectedSec / windowSec) * 100);
  }

  insertUptimeSummary.run(
    windowStart, windowEnd, endpointName,
    rows.length, successCount, Math.round(successRate * 100) / 100,
    Math.round(avgLat * 100) / 100, p50Lat, p99Lat, maxLat,
    rateLimitCount,
    Math.round(wsConnectedSec), Math.round(windowSec - wsConnectedSec),
    wsUptimePct != null ? Math.round(wsUptimePct * 100) / 100 : null,
    wsDisconnects
  );
}

// ── Query helpers ──

function getUptimeStats(hours) {
  const since = Date.now() - hours * 3600 * 1000;

  const endpoints = {};
  const names = db.prepare(`SELECT DISTINCT endpoint_name FROM health_checks WHERE timestamp >= ?`).all(since);

  for (const { endpoint_name } of names) {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_checks,
        SUM(CASE WHEN get_health_success AND get_slot_success AND get_account_success THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN rate_limited THEN 1 ELSE 0 END) as rate_limits,
        AVG(CASE WHEN get_health_success THEN get_health_latency END) as avg_health_lat,
        AVG(CASE WHEN get_slot_success THEN get_slot_latency END) as avg_slot_lat,
        AVG(CASE WHEN get_account_success THEN get_account_latency END) as avg_account_lat
      FROM health_checks
      WHERE endpoint_name = ? AND timestamp >= ?
    `).get(endpoint_name, since);

    // Get all successful latencies for p99
    const latRows = db.prepare(`
      SELECT get_health_latency as lat FROM health_checks WHERE endpoint_name = ? AND timestamp >= ? AND get_health_success = 1
      UNION ALL
      SELECT get_slot_latency FROM health_checks WHERE endpoint_name = ? AND timestamp >= ? AND get_slot_success = 1
      UNION ALL
      SELECT get_account_latency FROM health_checks WHERE endpoint_name = ? AND timestamp >= ? AND get_account_success = 1
    `).all(endpoint_name, since, endpoint_name, since, endpoint_name, since);

    const lats = latRows.map((r) => r.lat).filter(Boolean).sort((a, b) => a - b);
    const p99 = lats.length > 0 ? lats[Math.max(0, Math.ceil(lats.length * 0.99) - 1)] : 0;
    const avgLat = lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;

    // WS stats
    const wsStats = db.prepare(`
      SELECT
        COUNT(CASE WHEN event IN ('disconnected', 'heartbeat_timeout') THEN 1 END) as disconnects,
        SUM(CASE WHEN event = 'disconnected' AND duration_ms IS NOT NULL THEN duration_ms ELSE 0 END) as connected_ms
      FROM ws_connection_log
      WHERE endpoint_name = ? AND timestamp >= ?
    `).get(endpoint_name, since);

    const totalMs = hours * 3600 * 1000;
    const wsUptimePct = wsStats.connected_ms > 0 ? Math.round((wsStats.connected_ms / totalMs) * 10000) / 100 : null;

    endpoints[endpoint_name] = {
      successRate: stats.total_checks > 0 ? Math.round((stats.successful / stats.total_checks) * 1000) / 10 : 0,
      avgLatency: avgLat,
      p99Latency: p99,
      totalChecks: stats.total_checks,
      failures: stats.total_checks - stats.successful,
      rateLimits: stats.rate_limits || 0,
      wsUptimePct,
      wsDisconnects: wsStats.disconnects || 0,
    };
  }

  // Failover stats
  const foRows = db.prepare(`SELECT * FROM failover_events WHERE timestamp >= ? ORDER BY timestamp`).all(since);
  const avgRecovery = foRows.length > 0
    ? Math.round(foRows.filter((r) => r.recovery_time_ms).reduce((a, r) => a + (r.recovery_time_ms || 0), 0) / Math.max(1, foRows.filter((r) => r.recovery_time_ms).length))
    : 0;

  // Effective uptime: use health_checks — what % of all checks had at least one endpoint succeed?
  const effectiveRows = db.prepare(`
    SELECT timestamp,
      MAX(get_health_success AND get_slot_success AND get_account_success) as any_success
    FROM health_checks WHERE timestamp >= ?
    GROUP BY timestamp
  `).all(since);
  const effectiveTotal = effectiveRows.length;
  const effectiveSuccess = effectiveRows.filter((r) => r.any_success).length;
  const effectiveUptime = effectiveTotal > 0 ? Math.round((effectiveSuccess / effectiveTotal) * 10000) / 100 : 100;

  return {
    period: { from: since, to: Date.now(), hours },
    endpoints,
    failover: {
      totalEvents: foRows.length,
      avgRecoveryMs: avgRecovery,
      effectiveUptime,
      events: foRows.slice(-20),
    },
  };
}

function generateReport(hours) {
  const stats = getUptimeStats(hours || 24);
  const h = stats.period.hours;
  const fromStr = new Date(stats.period.from).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const toStr = new Date(stats.period.to).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const hDisplay = h >= 1 ? `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m` : `${Math.round(h * 60)}m`;

  let report = `=== RPC Reliability Report ===\n`;
  report += `Period: ${fromStr} — ${toStr} (${hDisplay})\n\n`;
  report += `ENDPOINT RANKING:\n`;

  const sorted = Object.entries(stats.endpoints).sort((a, b) => b[1].successRate - a[1].successRate);
  sorted.forEach(([name, ep], i) => {
    const shortName = name.length > 16 ? name.slice(0, 14) + ".." : name.padEnd(16);
    report += `${i + 1}. ${shortName}  ${ep.successRate}% success  ${ep.avgLatency}ms avg  ${ep.wsDisconnects} WS disconnects\n`;
  });

  report += `\nFAILOVER:\n`;
  report += `Total switches: ${stats.failover.totalEvents}\n`;
  report += `Avg recovery time: ${stats.failover.avgRecoveryMs > 0 ? (stats.failover.avgRecoveryMs / 1000).toFixed(1) + " seconds" : "N/A"}\n`;
  report += `Effective uptime with failover: ${stats.failover.effectiveUptime}%\n`;

  report += `\nVERDICT:\n`;
  report += `Public RPCs with failover achieved ${stats.failover.effectiveUptime}% effective uptime over ${hDisplay}.\n`;

  return report;
}

// ── Raw data queries ──

function getRawLatest() {
  const pools = db.prepare(`
    SELECT DISTINCT account_address, pool_label, dex, pool_type, program_id
    FROM raw_account_data ORDER BY dex, pool_type
  `).all();

  const grouped = {};

  for (const p of pools) {
    const latest = db.prepare(`
      SELECT * FROM raw_account_data
      WHERE account_address = ? AND success = 1
      ORDER BY timestamp DESC LIMIT 1
    `).get(p.account_address);

    const dex = p.dex || "Unknown";
    if (!grouped[dex]) grouped[dex] = [];

    grouped[dex].push({
      address: p.account_address,
      label: p.pool_label,
      poolType: p.pool_type,
      programId: p.program_id,
      lastUpdated: latest?.timestamp || null,
      slot: latest?.slot || null,
      dataSize: latest?.data_size || 0,
      lamports: latest?.lamports || 0,
      ownerProgram: latest?.owner_program || null,
      dataPreview: latest?.data_base64 ? latest.data_base64.slice(0, 200) : null,
    });
  }

  return grouped;
}

function getRawCompare() {
  const rows = db.prepare(`
    SELECT dex, pool_type, account_address,
      AVG(data_size) as avg_data_size,
      COUNT(*) as snapshot_count
    FROM raw_account_data
    WHERE success = 1 AND dex IS NOT NULL
    GROUP BY dex, pool_type, account_address
    ORDER BY dex, pool_type
  `).all();

  return rows.map((r) => ({
    dex: r.dex,
    poolType: r.pool_type,
    address: r.account_address,
    avgDataSize: Math.round(r.avg_data_size),
    snapshotCount: r.snapshot_count,
  }));
}

function getRawHistory(poolAddress, hours) {
  const since = Date.now() - (hours || 1) * 3600 * 1000;
  const label = db.prepare(`SELECT pool_label FROM raw_account_data WHERE account_address = ? LIMIT 1`).get(poolAddress);

  const entries = db.prepare(`
    SELECT timestamp, slot, data_size, lamports
    FROM raw_account_data
    WHERE account_address = ? AND timestamp >= ? AND success = 1
    ORDER BY timestamp
  `).all(poolAddress, since);

  return {
    pool: poolAddress,
    label: label?.pool_label || null,
    entries,
  };
}

function getRawExportCsv(poolAddress, hours) {
  const since = Date.now() - (hours || 24) * 3600 * 1000;
  const rows = db.prepare(`
    SELECT timestamp, slot, data_size, lamports, owner_program, data_base64
    FROM raw_account_data
    WHERE account_address = ? AND timestamp >= ? AND success = 1
    ORDER BY timestamp
  `).all(poolAddress, since);

  let csv = "timestamp,slot,data_size,lamports,owner_program,data_base64\n";
  for (const r of rows) {
    csv += `${r.timestamp},${r.slot},${r.data_size},${r.lamports},${r.owner_program || ""},${r.data_base64 || ""}\n`;
  }
  return csv;
}

// ── Parsed pool data queries ──

function getParsedLatest() {
  const latest = db.prepare(`
    SELECT * FROM parsed_pool_data
    WHERE parse_success = 1
    ORDER BY timestamp DESC LIMIT 1
  `).get();

  if (!latest) return null;

  // Price change helper: find closest record at or before target time
  function priceAt(poolAddress, msAgo) {
    const target = Date.now() - msAgo;
    const row = db.prepare(`
      SELECT price FROM parsed_pool_data
      WHERE pool_address = ? AND parse_success = 1 AND timestamp <= ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(poolAddress, target);
    return row?.price || null;
  }

  const priceChanges = {};
  const intervals = { "5m": 5 * 60000, "1h": 3600000, "6h": 6 * 3600000, "24h": 24 * 3600000 };
  for (const [label, ms] of Object.entries(intervals)) {
    const oldPrice = priceAt(latest.pool_address, ms);
    if (oldPrice && oldPrice > 0) {
      priceChanges[label] = Math.round(((latest.price - oldPrice) / oldPrice) * 10000) / 100;
    }
  }

  // Parse stats
  const parseStats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN parse_success = 1 THEN 1 ELSE 0 END) as successes,
      MIN(timestamp) as first_parse
    FROM parsed_pool_data WHERE pool_address = ?
  `).get(latest.pool_address);

  return {
    poolAddress: latest.pool_address,
    poolLabel: latest.pool_label,
    timestamp: latest.timestamp,
    baseMint: latest.base_mint,
    quoteMint: latest.quote_mint,
    lpMint: latest.lp_mint,
    baseVault: latest.base_vault,
    quoteVault: latest.quote_vault,
    baseDecimal: latest.base_decimal,
    quoteDecimal: latest.quote_decimal,
    baseAmount: latest.base_amount,
    quoteAmount: latest.quote_amount,
    baseAmountRaw: latest.base_amount_raw,
    quoteAmountRaw: latest.quote_amount_raw,
    price: latest.price,
    liquidityUsd: latest.liquidity_usd,
    feeRate: latest.fee_rate,
    status: latest.status,
    lpReserve: latest.lp_reserve,
    openOrders: latest.open_orders,
    marketId: latest.market_id,
    slot: latest.slot,
    priceChanges,
    parseStats: {
      total: parseStats.total,
      successes: parseStats.successes,
      successRate: parseStats.total > 0 ? Math.round((parseStats.successes / parseStats.total) * 1000) / 10 : 0,
      firstParse: parseStats.first_parse,
    },
  };
}

function getParsedHistory(poolAddress, hours) {
  const since = Date.now() - (hours || 1) * 3600 * 1000;

  const entries = db.prepare(`
    SELECT timestamp, price, base_amount, quote_amount, liquidity_usd, slot
    FROM parsed_pool_data
    WHERE pool_address = ? AND parse_success = 1 AND timestamp >= ?
    ORDER BY timestamp
  `).all(poolAddress, since);

  return {
    pool: poolAddress,
    entries,
  };
}

function getDbStats() {
  const hcCount = db.prepare("SELECT COUNT(*) as cnt FROM health_checks").get().cnt;
  const radCount = db.prepare("SELECT COUNT(*) as cnt FROM raw_account_data").get().cnt;
  const foCount = db.prepare("SELECT COUNT(*) as cnt FROM failover_events").get().cnt;
  const wsCount = db.prepare("SELECT COUNT(*) as cnt FROM ws_connection_log").get().cnt;
  const firstHc = db.prepare("SELECT MIN(timestamp) as ts FROM health_checks").get().ts;

  // Get file size
  const fs = require("fs");
  let fileSize = 0;
  try {
    fileSize = fs.statSync(DB_PATH).size;
  } catch {}

  return {
    healthChecks: hcCount,
    rawAccountData: radCount,
    failoverEvents: foCount,
    wsLogs: wsCount,
    collectingSince: firstHc || null,
    dbSizeBytes: fileSize,
    dbSizeMB: Math.round((fileSize / 1024 / 1024) * 10) / 10,
    dbPath: DB_PATH,
  };
}

// ── Cleanup: delete old data on startup ──

function cleanupOldData() {
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const threeDaysAgo = Date.now() - 3 * 24 * 3600 * 1000;

  const hcDeleted = db.prepare("DELETE FROM health_checks WHERE timestamp < ?").run(sevenDaysAgo).changes;
  const radDeleted = db.prepare("DELETE FROM raw_account_data WHERE timestamp < ?").run(threeDaysAgo).changes;
  const rsdDeleted = db.prepare("DELETE FROM raw_slot_data WHERE timestamp < ?").run(threeDaysAgo).changes;
  const ppdDeleted = db.prepare("DELETE FROM parsed_pool_data WHERE timestamp < ?").run(threeDaysAgo).changes;

  if (hcDeleted > 0 || radDeleted > 0 || rsdDeleted > 0 || ppdDeleted > 0) {
    console.log(`  DB cleanup: removed ${hcDeleted} health_checks (>7d), ${radDeleted} raw_account_data (>3d), ${rsdDeleted} raw_slot_data (>3d), ${ppdDeleted} parsed_pool_data (>3d)`);
    db.exec("VACUUM");
  }
}

function closeDb() {
  db.close();
}

module.exports = {
  db,
  DB_PATH,
  writeHealthCheck,
  writeFailoverEvent,
  writeWsLog,
  writeRawAccountData,
  writeRawSlotData,
  writeParsedPoolData,
  aggregateUptimeSummary,
  getUptimeStats,
  generateReport,
  getRawLatest,
  getRawCompare,
  getRawHistory,
  getRawExportCsv,
  getParsedLatest,
  getParsedHistory,
  getDbStats,
  cleanupOldData,
  closeDb,
};
