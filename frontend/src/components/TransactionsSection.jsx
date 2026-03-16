import React, { useState, useEffect, useCallback } from "react";
import InfoTip from "./Tooltip";

const POOL_OPTIONS = [
  { label: "All Pools", value: "" },
  { label: "Raydium AMM v4 — SOL/USDC", value: "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2" },
  { label: "Raydium CPMM — SOL/USDC", value: "7JuwJuNU88gurFnyWeiyGKbFmExMWcmRZntn9imEzdny" },
  { label: "Orca Whirlpool — SOL/USDC", value: "7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm" },
  { label: "Meteora DLMM — SOL/USDC", value: "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y" },
];

const PERIOD_OPTIONS = [
  { label: "5m", hours: 5 / 60 },
  { label: "30m", hours: 0.5 },
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
];

function truncAddr(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function formatUsd(val) {
  if (val == null || val === 0) return "—";
  if (val >= 1e6) return `$${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `$${(val / 1e3).toFixed(1)}K`;
  return `$${val.toFixed(2)}`;
}

function formatAmount(val) {
  if (val == null || val === 0) return "—";
  if (val >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
  if (val >= 1e3) return `${(val / 1e3).toFixed(1)}K`;
  return val.toFixed(4);
}

function formatTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatTimeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const EVENT_ICONS = {
  whale: "🐋",
  liquidity_add: "💧",
  liquidity_remove: "💧",
  new_pool: "🆕",
  swap: "↔️",
};

const SIDE_COLORS = {
  buy: "#22c55e",
  sell: "#ef4444",
};

function StatCard({ label, value, sub, hint }) {
  return (
    <div style={{
      background: "#0d0d0d",
      border: "1px solid #1a1a1a",
      borderRadius: 6,
      padding: "12px 16px",
      flex: "1 1 0",
      minWidth: 120,
    }}>
      <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", marginBottom: 4 }}>
        {hint ? <InfoTip text={hint}>{label}</InfoTip> : label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#fff", fontFamily: "monospace" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function TxTypeLabel({ txType, side }) {
  if (txType === "swap" && side) {
    return (
      <span style={{
        color: SIDE_COLORS[side] || "#aaa",
        fontWeight: 600,
        fontSize: 11,
        textTransform: "uppercase",
      }}>
        {side}
      </span>
    );
  }

  const labels = {
    add_liquidity: { text: "ADD LIQ", color: "#3b82f6" },
    remove_liquidity: { text: "REM LIQ", color: "#f59e0b" },
    initialize: { text: "INIT", color: "#a855f7" },
    failed: { text: "FAILED", color: "#ef4444" },
    other: { text: "OTHER", color: "#555" },
    unparsed: { text: "UNPARSED", color: "#444" },
    fetch_error: { text: "ERR", color: "#ef4444" },
  };
  const l = labels[txType] || { text: txType || "?", color: "#555" };
  return (
    <span style={{ color: l.color, fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>
      {l.text}
    </span>
  );
}

function EventBadge({ eventType }) {
  if (!eventType || eventType === "swap") return null;
  const icon = EVENT_ICONS[eventType] || "•";
  const labels = {
    whale: "whale",
    liquidity_add: "liq",
    liquidity_remove: "liq",
    new_pool: "new",
  };
  return (
    <span style={{
      background: eventType === "whale" ? "#1e1a2e" : "#111",
      border: `1px solid ${eventType === "whale" ? "#7c3aed" : "#333"}`,
      borderRadius: 4,
      padding: "1px 6px",
      fontSize: 10,
      color: eventType === "whale" ? "#a78bfa" : "#888",
      whiteSpace: "nowrap",
    }}>
      {icon} {labels[eventType] || eventType}
    </span>
  );
}

export default function TransactionsSection() {
  const [selectedPool, setSelectedPool] = useState("");
  const [selectedPeriod, setSelectedPeriod] = useState(2); // 1h default
  const [transactions, setTransactions] = useState([]);
  const [stats, setStats] = useState(null);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [txLimit, setTxLimit] = useState(30);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchData = useCallback(async () => {
    const period = PERIOD_OPTIONS[selectedPeriod];
    const poolParam = selectedPool ? `&pool=${selectedPool}` : "";

    try {
      const [txRes, statsRes, eventsRes] = await Promise.all([
        fetch(`/api/transactions/recent?limit=${txLimit}${poolParam}`),
        fetch(`/api/transactions/stats?period=${period.hours}${poolParam}`),
        fetch(`/api/events?limit=15`),
      ]);

      const txData = await txRes.json();
      const statsData = await statsRes.json();
      const eventsData = await eventsRes.json();

      const txns = txData.transactions || [];
      setTransactions(txns);
      setHasMore(txns.length >= txLimit);
      setStats(statsData);
      setEvents(eventsData.events || []);
    } catch (err) {
      console.error("[TransactionsSection] fetch error:", err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [selectedPool, selectedPeriod, txLimit]);

  // Reset limit when pool or period changes
  useEffect(() => {
    setTxLimit(30);
  }, [selectedPool, selectedPeriod]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  function loadMore() {
    setLoadingMore(true);
    setTxLimit((prev) => prev + 50);
  }

  return (
    <div>
      {/* Filters */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={selectedPool}
          onChange={(e) => setSelectedPool(e.target.value)}
          style={{
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 5,
            color: "#aaa",
            padding: "5px 8px",
            fontSize: 12,
          }}
        >
          {POOL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        <div style={{ display: "flex", gap: 0 }}>
          {PERIOD_OPTIONS.map((p, i) => (
            <button
              key={p.label}
              onClick={() => setSelectedPeriod(i)}
              style={{
                padding: "4px 12px",
                fontSize: 11,
                fontWeight: 600,
                border: "1px solid #333",
                borderRight: i < PERIOD_OPTIONS.length - 1 ? "none" : "1px solid #333",
                borderRadius: i === 0 ? "5px 0 0 5px" : i === PERIOD_OPTIONS.length - 1 ? "0 5px 5px 0" : 0,
                background: selectedPeriod === i ? "#3b82f6" : "#1a1a1a",
                color: selectedPeriod === i ? "#fff" : "#888",
                cursor: "pointer",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats cards */}
      {stats && (
        <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
          <StatCard
            label="TXNS"
            value={stats.swapCount?.toLocaleString() || "0"}
            sub={`Buy: ${stats.buyCount || 0} · Sell: ${stats.sellCount || 0}`}
            hint="Total number of swap transactions detected on this pool during the selected time period. Buy and sell counts reflect the direction from the trader's perspective (buying SOL vs selling SOL)."
          />
          <StatCard
            label="Volume"
            value={formatUsd(stats.volumeUsd)}
            hint="Estimated total USD volume of all swaps in the selected period. For SOL/USDC pools, this is calculated from the USDC (quote) side of each swap. Only includes parsed swaps where amounts could be extracted."
          />
          <StatCard
            label="Makers"
            value={stats.uniqueMakers?.toString() || "0"}
            hint="Number of unique wallet addresses that performed transactions in this period. A higher number of unique traders indicates broader market participation."
          />
          <StatCard
            label="Whale Trades"
            value={stats.whaleCount?.toString() || "0"}
            sub={stats.largestSwapUsd > 0 ? `Largest: ${formatUsd(stats.largestSwapUsd)}` : null}
            hint="Swaps exceeding $25,000 in value. Large trades can significantly impact pool reserves and price. Tracking whales helps identify potential price manipulation or major position changes."
          />
        </div>
      )}

      {/* Two-column layout: Recent Transactions + Events Feed */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 16 }}>
        {/* Recent Transactions table */}
        <div style={{
          background: "#0d0d0d",
          border: "1px solid #1a1a1a",
          borderRadius: 6,
          overflow: "hidden",
        }}>
          <div style={{
            padding: "8px 12px",
            borderBottom: "1px solid #1a1a1a",
            fontSize: 12,
            fontWeight: 600,
            color: "#888",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}>
            <InfoTip text="Real-time feed of transactions detected on the selected pool(s). Transactions are fetched via getSignaturesForAddress + getTransaction every 30 seconds. Only confirmed transactions are shown.">
              Recent Transactions
            </InfoTip>
            <span style={{ color: "#555", fontSize: 11, fontWeight: 400 }}>
              {transactions.length}{hasMore ? "+" : ""} shown
            </span>
          </div>

          {/* Header row */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "70px 55px 75px 75px 90px 70px",
            padding: "6px 12px",
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "#444",
            borderBottom: "1px solid #111",
          }}>
            <span>
              <InfoTip text="When the transaction was confirmed on the Solana blockchain (block time). Displayed in your local timezone.">
                Time
              </InfoTip>
            </span>
            <span>
              <InfoTip text={`The classified transaction type. Possible values:\n\n• BUY (green) — A swap where the trader bought SOL with USDC\n• SELL (red) — A swap where the trader sold SOL for USDC\n• ADD LIQ (blue) — Liquidity provider deposited tokens into the pool\n• REM LIQ (yellow) — Liquidity provider withdrew tokens from the pool\n• INIT (purple) — A new pool was initialized/created\n• OTHER (gray) — Transaction touched the pool but wasn't a swap (e.g. bots checking prices, crank operations, oracle updates)\n• UNPARSED (dark) — Non-AMM v4 pools where we collect data but don't parse yet (CPMM, Orca, Meteora)\n• FAILED — Transaction was submitted but failed on-chain\n• ERR — We couldn't fetch the full transaction data from the RPC`}>
                Type
              </InfoTip>
            </span>
            <span>
              <InfoTip text="The amount of SOL (base token) involved in the swap. For buy transactions, this is how much SOL the trader received. For sell transactions, this is how much SOL the trader gave up. Only available for parsed swap transactions.">
                Amount
              </InfoTip>
            </span>
            <span>
              <InfoTip text="The estimated USD value of the transaction, calculated from the USDC (quote token) side of the swap. Since USDC is a stablecoin pegged to $1, the USDC amount directly approximates the USD value.">
                USD
              </InfoTip>
            </span>
            <span>
              <InfoTip text="The Solana wallet address of the trader who initiated the transaction (the fee payer / signer). Shown truncated — first 4 and last 4 characters. Many transactions are from automated trading bots, not human traders.">
                Wallet
              </InfoTip>
            </span>
            <span>
              <InfoTip text={`Special event classification for notable transactions:\n\n• 🐋 whale — A swap exceeding $25,000 in value. Large enough to visibly move the pool price.\n• 💧 liq — Liquidity was added to or removed from the pool by an LP (liquidity provider).\n• 🆕 new — A brand new pool was created on-chain.\n\nRegular swaps under $25K don't show an event badge.`}>
                Event
              </InfoTip>
            </span>
          </div>

          {/* Transaction rows */}
          <div style={{ maxHeight: 500, overflow: "auto" }}>
            {transactions.length === 0 && (
              <div style={{ padding: "20px 12px", color: "#444", fontSize: 12, textAlign: "center" }}>
                {loading ? "Loading..." : "No transactions yet. Monitoring is running — data will appear as transactions are detected."}
              </div>
            )}
            {transactions.map((tx, i) => (
              <div
                key={tx.signature}
                style={{
                  display: "grid",
                  gridTemplateColumns: "70px 55px 75px 75px 90px 70px",
                  padding: "5px 12px",
                  fontSize: 12,
                  borderBottom: i < transactions.length - 1 ? "1px solid #0a0a0a" : "none",
                  background: tx.eventType === "whale" ? "rgba(124, 58, 237, 0.06)" : (i % 2 === 0 ? "transparent" : "#080808"),
                  alignItems: "center",
                }}
              >
                <span style={{ color: "#666", fontSize: 11 }}>
                  {formatTime(tx.timestamp)}
                </span>
                <TxTypeLabel txType={tx.txType} side={tx.side} />
                <span style={{ color: "#aaa", fontFamily: "monospace", fontSize: 11 }}>
                  {tx.baseAmount ? `${formatAmount(tx.baseAmount)} SOL` : "—"}
                </span>
                <span style={{ color: "#aaa", fontFamily: "monospace", fontSize: 11 }}>
                  {formatUsd(tx.usdValue)}
                </span>
                <span style={{ color: "#555", fontFamily: "monospace", fontSize: 11 }}>
                  {truncAddr(tx.traderWallet)}
                </span>
                <EventBadge eventType={tx.eventType} />
              </div>
            ))}
            {/* Load More button */}
            {hasMore && transactions.length > 0 && (
              <div style={{ padding: "10px 12px", textAlign: "center", borderTop: "1px solid #111" }}>
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  style={{
                    background: "#1a1a1a",
                    border: "1px solid #333",
                    borderRadius: 5,
                    color: loadingMore ? "#555" : "#aaa",
                    padding: "6px 20px",
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: loadingMore ? "default" : "pointer",
                  }}
                >
                  {loadingMore ? "Loading..." : `Load More (showing ${transactions.length})`}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Events Feed */}
        <div style={{
          background: "#0d0d0d",
          border: "1px solid #1a1a1a",
          borderRadius: 6,
          overflow: "hidden",
        }}>
          <div style={{
            padding: "8px 12px",
            borderBottom: "1px solid #1a1a1a",
            fontSize: 12,
            fontWeight: 600,
            color: "#888",
          }}>
            <InfoTip text="Notable events only — whale trades (>$25K), liquidity additions/removals, and new pool creation. Regular swaps are not shown here. Events are detected automatically from transaction analysis.">
              Events Feed
            </InfoTip>
          </div>

          <div style={{ maxHeight: 400, overflow: "auto" }}>
            {events.length === 0 && (
              <div style={{ padding: "20px 12px", color: "#444", fontSize: 12, textAlign: "center" }}>
                No notable events yet. Whale trades (&gt;$25K), liquidity changes, and new pools will appear here.
              </div>
            )}
            {events.map((evt, i) => (
              <div
                key={`${evt.signature || i}-${evt.timestamp}`}
                style={{
                  padding: "8px 12px",
                  borderBottom: i < events.length - 1 ? "1px solid #111" : "none",
                  background: evt.severity === "high" ? "rgba(124, 58, 237, 0.06)" : "transparent",
                }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 2 }}>
                  <span style={{ fontSize: 14 }}>{EVENT_ICONS[evt.eventType] || "•"}</span>
                  <span style={{ fontSize: 11, color: "#666" }}>{formatTimeAgo(evt.timestamp)}</span>
                  {evt.severity === "high" && (
                    <span style={{
                      fontSize: 9,
                      background: "#7c3aed",
                      color: "#fff",
                      borderRadius: 3,
                      padding: "1px 5px",
                      fontWeight: 600,
                    }}>
                      HIGH
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#ccc", paddingLeft: 22 }}>
                  {evt.description}
                </div>
                {evt.traderWallet && (
                  <div style={{ fontSize: 10, color: "#555", paddingLeft: 22, marginTop: 2, fontFamily: "monospace" }}>
                    {truncAddr(evt.traderWallet)}
                    {evt.usdValue ? ` · ${formatUsd(evt.usdValue)}` : ""}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer stats */}
      <div style={{
        display: "flex",
        gap: 24,
        padding: "10px 0",
        borderTop: "1px solid #222",
        fontSize: 12,
        flexWrap: "wrap",
        color: "#666",
        marginTop: 16,
      }}>
        <span>
          <InfoTip text="Total number of transactions stored in the database for all monitored pools. Includes swaps, liquidity events, and unclassified transactions.">
            Total stored
          </InfoTip>:{" "}
          <span style={{ color: "#aaa" }}>{stats?.totalCount?.toLocaleString() || "0"}</span>
        </span>
        <span>
          <InfoTip text="Number of liquidity addition events detected. LPs (liquidity providers) depositing tokens into the pool to earn trading fees.">
            Liq adds
          </InfoTip>:{" "}
          <span style={{ color: "#aaa" }}>{stats?.liqAddCount || 0}</span>
        </span>
        <span>
          <InfoTip text="Number of liquidity removal events detected. LPs withdrawing their tokens from the pool.">
            Liq removes
          </InfoTip>:{" "}
          <span style={{ color: "#aaa" }}>{stats?.liqRemoveCount || 0}</span>
        </span>
      </div>
    </div>
  );
}
