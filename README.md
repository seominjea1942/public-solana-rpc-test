# Solana RPC Health Tester & Failover Experiment

Test multiple public Solana RPC endpoints for reliability, latency, and rate limits. Includes automatic failover simulation.

## Endpoints Tested

| Endpoint | Auth Required |
|----------|--------------|
| Solana Foundation | No |
| PublicNode | No |
| Ankr | No |
| Helius Free | API key (free) |

## Quick Start

```bash
# Install all dependencies
npm run install:all

# Run both backend + frontend
npm start

# Or with Helius:
HELIUS_API_KEY=your_key npm start
```

- Backend: http://localhost:3001
- Dashboard: http://localhost:5173

## Run Separately

```bash
# Terminal 1: Backend
cd backend
npm install
HELIUS_API_KEY=your_key node server.js

# Terminal 2: Frontend
cd frontend
npm install
npm run dev
```

## What It Tests

### HTTP Health Checks (every 5s)
- `getHealth` — basic liveness
- `getSlot` — current slot (detects stale nodes)
- `getAccountInfo` — real Raydium SOL/USDC pool (simulates actual usage)

### WebSocket Connections
- Subscribes to Raydium pool account updates
- Tracks: uptime, message frequency, disconnect history

### Failover Simulator
- Picks healthiest RPC as primary
- Polls every 2s, auto-switches on failure
- Logs every failover event with reason

## Health Criteria

An RPC is marked unhealthy if ANY of:
- 3+ consecutive failures
- Average latency > 2000ms
- Success rate < 90%
- Slot drift > 10 (behind other RPCs)

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Current health of all RPCs |
| `GET /api/stats` | Aggregated stats + latency history |
| `GET /api/failover-log` | Failover events |
| `GET /api/ws-status` | WebSocket connection statuses |
| `GET /api/stream` | SSE stream for real-time updates |
