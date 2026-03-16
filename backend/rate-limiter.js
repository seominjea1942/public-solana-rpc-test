const { HTTP_TIMEOUT } = require("./config");

/**
 * Token-bucket rate limiter.
 * Refills tokens at a steady rate. Each RPC call consumes one token.
 * If no tokens are available, the caller waits until one is.
 */
class RateLimiter {
  constructor(maxPerSecond) {
    this.maxPerSecond = maxPerSecond;
    this.tokens = maxPerSecond;
    this.lastRefill = Date.now();

    // Stats
    this.totalRequests = 0;
    this.throttledCount = 0;
    this.total429s = 0;
    this.requestTimestamps = []; // for computing current req/sec
    this.peakReqPerSec = 0;

    // 429 backoff
    this._backoffUntil = 0;
  }

  async acquire() {
    // If we recently got a 429, back off
    const now = Date.now();
    if (now < this._backoffUntil) {
      const wait = this._backoffUntil - now;
      this.throttledCount++;
      await new Promise((r) => setTimeout(r, wait));
    }

    // Refill tokens based on elapsed time
    const currentNow = Date.now();
    const elapsed = (currentNow - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxPerSecond, this.tokens + elapsed * this.maxPerSecond);
    this.lastRefill = currentNow;

    if (this.tokens >= 1) {
      this.tokens -= 1;
    } else {
      // Wait until a token is available
      const waitMs = ((1 - this.tokens) / this.maxPerSecond) * 1000;
      this.throttledCount++;
      await new Promise((r) => setTimeout(r, waitMs));
      this.tokens = 0;
      this.lastRefill = Date.now();
    }

    this.totalRequests++;
    this._trackRequest();
  }

  /** Call this when any RPC returns HTTP 429. Backs off for 2 seconds. */
  report429() {
    this.total429s++;
    this._backoffUntil = Date.now() + 2000;
    console.warn("[RateLimiter] 429 received — backing off for 2 seconds");
  }

  _trackRequest() {
    const now = Date.now();
    this.requestTimestamps.push(now);
    // Keep only last 5 seconds for rolling average
    const cutoff = now - 5000;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps.shift();
    }
    const currentRate = this.requestTimestamps.length / 5;
    if (currentRate > this.peakReqPerSec) {
      this.peakReqPerSec = Math.round(currentRate * 10) / 10;
    }
  }

  getStats() {
    const now = Date.now();
    const cutoff = now - 5000;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps.shift();
    }
    return {
      currentReqPerSec: Math.round((this.requestTimestamps.length / 5) * 10) / 10,
      peakReqPerSec: this.peakReqPerSec,
      totalRequests: this.totalRequests,
      throttledCount: this.throttledCount,
      total429s: this.total429s,
      tokensRemaining: Math.round(this.tokens * 10) / 10,
      maxPerSecond: this.maxPerSecond,
    };
  }
}

// ── Global instance: 5 req/sec ──
// Health checks (~1.2 req/sec) + failover simulator (~0.5 req/sec) are separate,
// so we budget 5 req/sec for the scheduler pipeline, keeping total under 10/sec.
const limiter = new RateLimiter(5);

/**
 * Rate-limited JSON-RPC POST call.
 * Acquires a rate-limiter token before making the request.
 * Automatically reports 429s for backoff.
 *
 * Returns: { latency, success, rateLimited, data, error }
 * (same shape as rpcPost in rpc-tester.js)
 */
async function rateLimitedRpcPost(url, method, params = []) {
  await limiter.acquire();

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
      limiter.report429();
      return { latency, success: false, rateLimited: true, data: null, error: "429 Too Many Requests" };
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

module.exports = { RateLimiter, limiter, rateLimitedRpcPost };
