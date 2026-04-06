// src/tradeMemory.js
// Agent belajar dari trade history sendiri
// Tracking: hit rate, strategy performance, pool performance, timing patterns

import fs from "fs";
import path from "path";

const MEMORY_FILE = "./data/trade_memory.json";

// ─── Data structure ──────────────────────────────────────────────────

function emptyMemory() {
  return {
    trades: [],           // semua trade history
    stats: {
      totalTrades: 0,
      winners: 0,
      losers: 0,
      breakeven: 0,
      hitRate: 0,
      avgPnlPercent: 0,
      totalPnlSol: 0,
    },
    strategyStats: {
      spot: { trades: 0, winners: 0, hitRate: 0, avgPnl: 0 },
      curve: { trades: 0, winners: 0, hitRate: 0, avgPnl: 0 },
      "bid-ask": { trades: 0, winners: 0, hitRate: 0, avgPnl: 0 },
    },
    poolStats: {},        // per-pool performance
    badPools: [],         // pool yang konsisten rugi — hindari
    goodPools: [],        // pool yang konsisten profit
    lastUpdated: null,
  };
}

// ─── Persistence ─────────────────────────────────────────────────────

function loadMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return emptyMemory();
    const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return emptyMemory();
  }
}

function saveMemory(memory) {
  try {
    const dir = path.dirname(MEMORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    memory.lastUpdated = new Date().toISOString();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error("❌ Failed to save trade memory:", err.message);
  }
}

// ─── Trade lifecycle ──────────────────────────────────────────────────

/**
 * Catat posisi baru yang dibuka
 */
export function recordTradeOpen({ positionId, pool, poolName, strategy, solDeployed, decision }) {
  const memory = loadMemory();

  const trade = {
    id: positionId,
    pool,
    poolName,
    strategy,
    solDeployed,
    openedAt: new Date().toISOString(),
    closedAt: null,
    llmConfidence: decision.confidence,
    llmRationale: decision.rationale,
    opportunityScore: decision.opportunityScore ?? null,

    // Di-isi saat close
    solReturned: null,
    pnlSol: null,
    pnlPercent: null,
    outcome: null,       // "win" | "loss" | "breakeven"
    holdDurationHours: null,
  };

  memory.trades.push(trade);
  saveMemory(memory);

  console.log(`📝 Trade recorded: ${positionId}`);
}

/**
 * Catat posisi yang ditutup + kalkulasi P&L
 */
export function recordTradeClose({ positionId, solReturned, preClosePnlPct = null, poolName = null, solDeployed = null }) {
  const memory = loadMemory();

  let trade = memory.trades.find((t) => t.id === positionId);

  // Create trade record if not found (synced/manual positions)
  if (!trade) {
    trade = {
      id: positionId,
      pool: null,
      poolName: poolName ?? "unknown",
      strategy: "spot",
      solDeployed: solDeployed ?? 0,
      openedAt: new Date().toISOString(),
      closedAt: null,
      llmConfidence: null,
      llmRationale: null,
      opportunityScore: null,
      solReturned: null,
      pnlSol: null,
      pnlPercent: null,
      outcome: null,
      holdDurationHours: null,
    };
    memory.trades.push(trade);
    console.log(`  [TradeMemory] created missing record for ${positionId}`);
  }

  let pnlSol, pnlPercent, pnlSource;
  if (typeof preClosePnlPct === "number") {
    pnlPercent = preClosePnlPct;
    pnlSol = (pnlPercent / 100) * (trade.solDeployed || solDeployed || 0);
    pnlSource = "usd-precise";
  } else {
    pnlSol = 0;
    pnlPercent = 0;
    pnlSource = "unavailable";
    console.log(`  [PnL] unavailable at close — recording as 0%`);
  }

  const holdDurationHours =
    (Date.now() - new Date(trade.openedAt).getTime()) / 3_600_000;

  trade.closedAt = new Date().toISOString();
  trade.solReturned = solReturned;
  trade.pnlSol = pnlSol;
  trade.pnlPercent = pnlPercent;
  trade.pnlSource = pnlSource;
  trade.holdDurationHours = holdDurationHours.toFixed(1);
  trade.outcome = pnlPercent > 1 ? "win" : pnlPercent < -1 ? "loss" : "breakeven";

  // Rekalkulasi stats
  recalculateStats(memory);
  saveMemory(memory);

  console.log(
    `📊 Trade closed: ${positionId} | P&L: ${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}% [${pnlSource}] | ${trade.outcome.toUpperCase()}`
  );

  return trade;
}

// ─── Stats recalculation ──────────────────────────────────────────────

function recalculateStats(memory) {
  const closed = memory.trades.filter((t) => t.closedAt !== null);

  if (closed.length === 0) return;

  // Re-derive outcome from actual pnlPercent (fixes stale outcomes from broken PnL era)
  for (const t of closed) {
    const pnl = parseFloat(t.pnlPercent ?? 0);
    t.outcome = pnl > 1 ? "win" : pnl < -1 ? "loss" : "breakeven";
  }

  // Overall stats
  const winners = closed.filter((t) => t.outcome === "win").length;
  const losers = closed.filter((t) => t.outcome === "loss").length;
  const breakeven = closed.filter((t) => t.outcome === "breakeven").length;
  const totalPnl = closed.reduce((a, t) => a + (t.pnlSol ?? 0), 0);
  const avgPnl = closed.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / closed.length;

  memory.stats = {
    totalTrades: closed.length,
    winners,
    losers,
    breakeven,
    hitRate: ((winners / closed.length) * 100).toFixed(1),
    avgPnlPercent: avgPnl.toFixed(2),
    totalPnlSol: totalPnl.toFixed(4),
  };

  // Strategy stats
  ["spot", "curve", "bid-ask"].forEach((strat) => {
    const stratTrades = closed.filter((t) => t.strategy === strat);
    if (stratTrades.length === 0) return;
    const stratWinners = stratTrades.filter((t) => t.outcome === "win").length;
    const stratAvgPnl =
      stratTrades.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / stratTrades.length;

    memory.strategyStats[strat] = {
      trades: stratTrades.length,
      winners: stratWinners,
      hitRate: ((stratWinners / stratTrades.length) * 100).toFixed(1),
      avgPnl: stratAvgPnl.toFixed(2),
    };
  });

  // Pool stats
  const poolGroups = {};
  closed.forEach((t) => {
    if (!poolGroups[t.pool]) poolGroups[t.pool] = [];
    poolGroups[t.pool].push(t);
  });

  Object.entries(poolGroups).forEach(([pool, trades]) => {
    const poolWinners = trades.filter((t) => t.outcome === "win").length;
    const poolAvgPnl = trades.reduce((a, t) => a + (t.pnlPercent ?? 0), 0) / trades.length;
    memory.poolStats[pool] = {
      name: trades[0].poolName,
      trades: trades.length,
      hitRate: ((poolWinners / trades.length) * 100).toFixed(1),
      avgPnl: poolAvgPnl.toFixed(2),
    };
  });

  // Update good/bad pools — only blacklist after 5+ trades with very poor avg PnL
  // (Previous threshold of 3 trades / -2% was too aggressive, especially with inaccurate PnL data)
  memory.badPools = Object.entries(memory.poolStats)
    .filter(([, s]) => s.trades >= 5 && parseFloat(s.avgPnl) < -10)
    .map(([addr]) => addr);

  memory.goodPools = Object.entries(memory.poolStats)
    .filter(([, s]) => s.trades >= 3 && parseFloat(s.avgPnl) > 2)
    .map(([addr]) => addr);
}

// ─── Query functions ─────────────────────────────────────────────────

/**
 * Ambil context memory buat dikirim ke LLM
 */
export function getMemoryContextForLLM() {
  const memory = loadMemory();
  const stats = memory.stats;

  if (stats.totalTrades === 0) {
    return "No trade history yet — this is the first session.";
  }

  const bestStrategy = getBestStrategy(memory.strategyStats);
  const worstStrategy = getWorstStrategy(memory.strategyStats);

  return [
    `=== AGENT TRADE HISTORY ===`,
    `Total trades: ${stats.totalTrades} | Hit rate: ${stats.hitRate}%`,
    `Total P&L: ${stats.totalPnlSol} SOL | Avg per trade: ${stats.avgPnlPercent}%`,
    `Winners: ${stats.winners} | Losers: ${stats.losers} | Breakeven: ${stats.breakeven}`,
    ``,
    `=== STRATEGY PERFORMANCE ===`,
    formatStrategyStats(memory.strategyStats),
    `Best strategy: ${bestStrategy} | Worst: ${worstStrategy}`,
    ``,
    `=== POOL INTELLIGENCE ===`,
    `Avoid these pools (consistent loss): ${memory.badPools.slice(0, 5).join(", ") || "none"}`,
    `Prefer these pools (consistent profit): ${memory.goodPools.slice(0, 5).join(", ") || "none"}`,
    ``,
    `=== RECENT TRADES (last 5) ===`,
    formatRecentTrades(memory.trades),
  ].join("\n");
}

/**
 * Cek apakah pool ini dalam blacklist
 */
export function isPoolBlacklisted(poolAddress) {
  const memory = loadMemory();
  return memory.badPools.includes(poolAddress);
}

/**
 * Get full stats (buat Telegram /stats command)
 */
export function getFullStats() {
  return loadMemory();
}

// ─── Formatting helpers ───────────────────────────────────────────────

function formatStrategyStats(stratStats) {
  return Object.entries(stratStats)
    .map(([name, s]) => {
      if (s.trades === 0) return `  ${name}: no data`;
      return `  ${name}: ${s.trades} trades | ${s.hitRate}% hit | avg ${s.avgPnl}%`;
    })
    .join("\n");
}

function formatRecentTrades(trades) {
  const closed = trades.filter((t) => t.closedAt).slice(-5).reverse();
  if (closed.length === 0) return "  No closed trades yet";

  return closed
    .map(
      (t) =>
        `  ${t.outcome === "win" ? "✅" : t.outcome === "loss" ? "❌" : "➡️"} ${t.poolName} | ${t.strategy} | ${t.pnlPercent >= 0 ? "+" : ""}${parseFloat(t.pnlPercent).toFixed(1)}% | held ${t.holdDurationHours}h`
    )
    .join("\n");
}

function getBestStrategy(stats) {
  return Object.entries(stats)
    .filter(([, s]) => s.trades >= 2)
    .sort((a, b) => parseFloat(b[1].avgPnl) - parseFloat(a[1].avgPnl))[0]?.[0] ?? "unknown";
}

function getWorstStrategy(stats) {
  return Object.entries(stats)
    .filter(([, s]) => s.trades >= 2)
    .sort((a, b) => parseFloat(a[1].avgPnl) - parseFloat(b[1].avgPnl))[0]?.[0] ?? "unknown";
}

export function isTokenTradedRecently(poolName, hours = 24) {
  const { trades } = getFullStats();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return trades.some(t => 
    t.poolName && poolName && 
    t.poolName.toLowerCase() === poolName.toLowerCase() && 
    new Date(t.entryTime).getTime() > cutoff
  );
}
