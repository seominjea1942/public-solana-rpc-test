const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const RPC_ENDPOINTS = [
  {
    name: "Solana Foundation",
    http: "https://api.mainnet-beta.solana.com",
    ws: "wss://api.mainnet-beta.solana.com",
  },
  {
    name: "PublicNode",
    http: "https://solana-rpc.publicnode.com",
    ws: "wss://solana-rpc.publicnode.com",
  },
  {
    name: "Ankr",
    http: "https://rpc.ankr.com/solana",
    ws: "wss://rpc.ankr.com/solana",
  },
];

if (HELIUS_API_KEY) {
  RPC_ENDPOINTS.push({
    name: "Helius Free",
    http: `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
    ws: `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
  });
}

// Raydium SOL/USDC pool account
const TEST_ACCOUNT = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";

// Timing
const HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
const HTTP_TIMEOUT = 3000; // 3 seconds
const WS_HEARTBEAT_TIMEOUT = 30000; // 30 seconds
const WS_MAX_RETRIES = 3;
const RESULTS_WINDOW = 60; // keep last 60 results (5 min at 5s interval)
const FAILOVER_POLL_INTERVAL = 2000; // 2 seconds

module.exports = {
  RPC_ENDPOINTS,
  TEST_ACCOUNT,
  HEALTH_CHECK_INTERVAL,
  HTTP_TIMEOUT,
  WS_HEARTBEAT_TIMEOUT,
  WS_MAX_RETRIES,
  RESULTS_WINDOW,
  FAILOVER_POLL_INTERVAL,
  HELIUS_API_KEY,
};
