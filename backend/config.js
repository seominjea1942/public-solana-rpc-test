const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const RPC_ENDPOINTS = [
  {
    name: "Solana Foundation",
    http: "https://api.mainnet-beta.solana.com",
    ws: "wss://api.mainnet-beta.solana.com",
    description: "Official free RPC run by the Solana Foundation — the nonprofit that created and maintains the Solana blockchain.",
    details: {
      operator: "Solana Foundation (nonprofit)",
      authRequired: false,
      rateLimit: "100 req/10sec per IP",
      bestFor: "Most widely used, baseline reliability",
      risk: "Shared by millions of users. Slows down during network congestion.",
    },
    info: {
      endpoint: "api.mainnet-beta.solana.com",
      auth: "None",
      rateLimit: "100 req/10sec per IP",
    },
  },
  {
    name: "PublicNode",
    http: "https://solana-rpc.publicnode.com",
    ws: "wss://solana-rpc.publicnode.com",
    description: "Free RPC by PublicNode — a company that provides free, privacy-focused blockchain endpoints for multiple chains.",
    details: {
      operator: "PublicNode (infrastructure company)",
      authRequired: false,
      rateLimit: "Not published, generally generous",
      bestFor: "Often faster than Solana Foundation, good secondary",
      risk: "Smaller company, less battle-tested under extreme load.",
    },
    info: {
      endpoint: "solana-rpc.publicnode.com",
      auth: "None",
      rateLimit: "Not published, generally generous",
    },
  },
];

if (HELIUS_API_KEY) {
  RPC_ENDPOINTS.push({
    name: "Helius Free",
    http: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
    ws: `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
    description: "Free-tier RPC by Helius — a Solana-focused infrastructure company known for fast, reliable RPC and enriched APIs.",
    details: {
      operator: "Helius (Solana-focused, VC-backed)",
      authRequired: true,
      rateLimit: "Free tier: 10 req/sec",
      bestFor: "Solana-native company, often lowest latency",
      risk: "Requires API key signup. Free tier has strict limits.",
    },
    info: {
      endpoint: "mainnet.helius-rpc.com",
      auth: "API key required",
      rateLimit: "Free tier: 10 req/sec",
    },
  });
}

// Multi-DEX pool accounts to monitor (rotate through them)
const POOL_ACCOUNTS = [
  // === Raydium AMM v4 (legacy, most pools, 83% of Raydium TVL) ===
  {
    address: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2",
    label: "Raydium AMM v4 — SOL/USDC",
    dex: "Raydium",
    poolType: "AMM v4",
    programId: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  },
  // === Raydium CPMM (newer, growing fast, 49% of Raydium swap revenue) ===
  // Note: No high-liquidity SOL/USDC CPMM pool exists on Raydium.
  // Using USELESS/SOL ($1.7M liq, 3800 txns/day) to demonstrate CPMM parsing.
  {
    address: "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp",
    label: "Raydium CPMM — USELESS/SOL",
    dex: "Raydium",
    poolType: "CPMM",
    programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  },
  // === Orca Whirlpool (2nd largest Solana DEX, concentrated liquidity) ===
  {
    address: "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm",
    label: "Orca Whirlpool — SOL/USDC",
    dex: "Orca",
    poolType: "Whirlpool",
    programId: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  },
  // === Meteora DLMM (fastest growing, dynamic fees) ===
  {
    address: "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y",
    label: "Meteora DLMM — SOL/USDC",
    dex: "Meteora",
    poolType: "DLMM",
    programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  },
];

// Default test account (first pool)
const TEST_ACCOUNT = POOL_ACCOUNTS[0].address;

// Pool rotation state
let _poolIndex = 0;
function getNextPool() {
  const pool = POOL_ACCOUNTS[_poolIndex];
  _poolIndex = (_poolIndex + 1) % POOL_ACCOUNTS.length;
  return pool;
}

// Timing
const HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
const HTTP_TIMEOUT = 3000; // 3 seconds
const WS_HEARTBEAT_TIMEOUT = 120000; // 120 seconds (public endpoints can be slow)
const WS_MAX_RETRIES = 5;
const WS_RECOVERY_INTERVAL = 300000; // 5 minutes — retry dead connections periodically
const WS_PING_INTERVAL = 30000; // 30 seconds — send WS ping frames to keep alive
// Keep enough results for long-range charts (3 days at 5s = 51840, cap at 72h)
const RESULTS_WINDOW = 51840;
const FAILOVER_POLL_INTERVAL = 2000; // 2 seconds

module.exports = {
  RPC_ENDPOINTS,
  POOL_ACCOUNTS,
  TEST_ACCOUNT,
  getNextPool,
  HEALTH_CHECK_INTERVAL,
  HTTP_TIMEOUT,
  WS_HEARTBEAT_TIMEOUT,
  WS_MAX_RETRIES,
  WS_RECOVERY_INTERVAL,
  WS_PING_INTERVAL,
  RESULTS_WINDOW,
  FAILOVER_POLL_INTERVAL,
  HELIUS_API_KEY,
};
