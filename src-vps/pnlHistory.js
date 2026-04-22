// src-vps/pnlHistory.js
// Part 20: Weekly + Monthly PnL aggregation.
//
// Each midnight WIB reset (Part 14 dailyCircuitBreaker) snapshots the day's
// final tracker state + trade stats here before the baseline gets reset.
// Weekly/Monthly queries aggregate from this rolling 90-day history.
//
// Idempotent: same-date entries are replaced, not duplicated. Snapshot errors
// are swallowed by the caller so a failure can never block the daily reset.

import fs from "fs";
import path from "path";

const HISTORY_FILE = path.resolve("data/daily_pnl_history.json");
const RETENTION_DAYS = 90;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// ── WIB date helpers ──────────────────────────────────────────────────────

function getWibDate(now = new Date()) {
  const wib = new Date(now.getTime() + WIB_OFFSET_MS);
  const y = wib.getUTCFullYear();
  const m = String(wib.getUTCMonth() + 1).padStart(2, "0");
  const d = String(wib.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseWibDate(wibDateStr) {
  // "YYYY-MM-DD" → Date at UTC midnight of that calendar day in WIB timezone.
  // WIB midnight = UTC (date - 7h) of the same calendar date.
  const [y, m, d] = wibDateStr.split("-").map(Number);
  // WIB midnight corresponds to UTC 17:00 the previous calendar day.
  return new Date(Date.UTC(y, m - 1, d) - WIB_OFFSET_MS);
}

function getWibDayRangeUtc(wibDateStr) {
  const start = parseWibDate(wibDateStr).getTime();
  return [start, start + 24 * 60 * 60 * 1000];
}

function getWibDayOfWeek(wibDateStr) {
  // Mon/Tue/... label. Date in WIB — use UTC methods on the offset date.
  const wib = new Date(parseWibDate(wibDateStr).getTime() + WIB_OFFSET_MS);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][wib.getUTCDay()];
}

function addDaysToWibDate(wibDateStr, delta) {
  const ms = parseWibDate(wibDateStr).getTime() + delta * 24 * 60 * 60 * 1000;
  return getWibDate(new Date(ms));
}

// ISO-8601: week starts Monday. Returns YYYY-MM-DD (WIB) of the Monday of
// the week that contains the given WIB date.
function getWeekStartWibDate(wibDateStr) {
  const wib = new Date(parseWibDate(wibDateStr).getTime() + WIB_OFFSET_MS);
  const dow = wib.getUTCDay();            // Sun=0 … Sat=6
  const mondayOffset = (dow === 0) ? -6 : (1 - dow); // back to Mon
  return addDaysToWibDate(wibDateStr, mondayOffset);
}

function getMonthStartWibDate(wibDateStr, monthsAgo = 0) {
  const [y, m] = wibDateStr.split("-").map(Number);
  // JavaScript Date handles month rollover naturally.
  const targetY = y;
  const targetM = m - 1 - monthsAgo; // 0-indexed month
  const d = new Date(Date.UTC(targetY, targetM, 1));
  const yr = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yr}-${mo}-01`;
}

function getMonthLabel(wibDateStr) {
  const [y, m] = wibDateStr.split("-").map(Number);
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${names[m - 1]} ${y}`;
}

// ── Storage ───────────────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
      return Array.isArray(arr) ? arr : [];
    }
  } catch (e) {
    console.warn(`[PnLHistory] load error: ${e.message}`);
  }
  return [];
}

function saveHistory(entries) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.warn(`[PnLHistory] save error: ${e.message}`);
  }
}

function pruneAndSort(entries) {
  // Keep unique-by-date (last write wins), ISO-date sorted ASC, last N only.
  const byDate = new Map();
  for (const e of entries) {
    if (e && e.date) byDate.set(e.date, e);
  }
  const sorted = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  return sorted.slice(-RETENTION_DAYS);
}

// ── Today's trade stats (computed on-demand at snapshot time) ────────────

export function computeTodayTradeStats(wibDateStr = getWibDate()) {
  // Read trade_memory.json, filter trades whose closedAt falls within the
  // WIB calendar day, compute WR/avg/best/worst/fees/count.
  const tradesFile = path.resolve("data/trade_memory.json");
  let trades = [];
  try {
    const raw = JSON.parse(fs.readFileSync(tradesFile, "utf-8"));
    trades = Array.isArray(raw) ? raw : (raw.trades ?? raw.closedTrades ?? Object.values(raw));
  } catch {}
  if (!Array.isArray(trades)) trades = [];

  const [startUtc, endUtc] = getWibDayRangeUtc(wibDateStr);
  const today = trades.filter(t => {
    const ts = Date.parse(t?.closedAt ?? "");
    return Number.isFinite(ts) && ts >= startUtc && ts < endUtc;
  });

  const pnlPcts = [];
  const pnlUsds = [];
  let wins = 0, losses = 0, breakeven = 0;
  let fees = 0;
  for (const t of today) {
    const pct = Number(t.pnlPercent);
    const usd = Number(t.pnlUsd);
    if (Number.isFinite(pct)) pnlPcts.push(pct);
    if (Number.isFinite(usd)) pnlUsds.push(usd);
    const outcome = (t.outcome ?? "").toLowerCase();
    if (outcome === "win") wins++;
    else if (outcome === "loss") losses++;
    else breakeven++;
    const fee = Number(t.claimedFeesUsd ?? t.feesUsd);
    if (Number.isFinite(fee)) fees += fee;
  }

  const wrBase = wins + losses;
  const avgOf = arr => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const wins_pcts = pnlPcts.filter(x => x > 0);
  const losses_pcts = pnlPcts.filter(x => x < 0);

  return {
    trades_count: today.length,
    wins, losses, breakeven,
    win_rate: wrBase ? Math.round((wins / wrBase) * 100) : 0,
    avg_win_pct: Number(avgOf(wins_pcts).toFixed(2)),
    avg_loss_pct: Number(avgOf(losses_pcts).toFixed(2)),
    best_trade_pct: pnlPcts.length ? Number(Math.max(...pnlPcts).toFixed(2)) : 0,
    worst_trade_pct: pnlPcts.length ? Number(Math.min(...pnlPcts).toFixed(2)) : 0,
    fees_usd: Number(fees.toFixed(2)),
    total_pnl_usd_from_trades: Number(pnlUsds.reduce((a, b) => a + b, 0).toFixed(2)),
  };
}

// ── Snapshot ──────────────────────────────────────────────────────────────

export async function snapshotDailyPnl(tracker, tradeStatsArg = null) {
  try {
    if (!tracker || !tracker.date) return null;
    const wibDate = tracker.date; // tracker stores WIB date string
    const tradeStats = tradeStatsArg ?? computeTodayTradeStats(wibDate);

    const pnlUsd = Number(tracker.lastCheckDeltaUsd ?? 0);
    const solPriceEod = Number(tracker.lastSolPrice ?? tracker.baselineSolPrice ?? 0);
    const baselineUsd = Number(tracker.baselineUsdValue ?? 0);
    const finalEquityUsd = baselineUsd + pnlUsd;
    let cbFired = null;
    if (tracker.profitFired) cbFired = "profit";
    else if (tracker.lossFired) cbFired = "loss";
    else if (tracker.hedgeFired) cbFired = "hedge";

    const entry = {
      date: wibDate,
      day_of_week: getWibDayOfWeek(wibDate),
      pnl_usd: Number(pnlUsd.toFixed(2)),
      trades_count: tradeStats.trades_count,
      wins: tradeStats.wins,
      losses: tradeStats.losses,
      breakeven: tradeStats.breakeven,
      win_rate: tradeStats.win_rate,
      avg_win_pct: tradeStats.avg_win_pct,
      avg_loss_pct: tradeStats.avg_loss_pct,
      best_trade_pct: tradeStats.best_trade_pct,
      worst_trade_pct: tradeStats.worst_trade_pct,
      fees_usd: tradeStats.fees_usd,
      sol_price_eod: Number(solPriceEod.toFixed(4)),
      baseline_usd: Number(baselineUsd.toFixed(2)),
      final_equity_usd: Number(finalEquityUsd.toFixed(2)),
      circuit_breaker_fired: cbFired,
      snapshot_at: new Date().toISOString(),
    };

    const current = loadHistory();
    current.push(entry);
    const pruned = pruneAndSort(current);
    saveHistory(pruned);
    console.log(`[PnLHistory] snapshot ${wibDate} pnl=$${entry.pnl_usd.toFixed(2)} trades=${entry.trades_count} (WR ${entry.win_rate}%) — ${pruned.length} day(s) retained`);
    return entry;
  } catch (err) {
    console.warn(`[PnLHistory] snapshot error: ${err.message}`);
    return null;
  }
}

// ── Aggregation ──────────────────────────────────────────────────────────

function aggregateDays(days, label, periodStart, periodEnd) {
  if (!days.length) {
    return { label, periodStart, periodEnd, days: [], empty: true };
  }
  const totalPnl = days.reduce((s, d) => s + (d.pnl_usd ?? 0), 0);
  const winDays = days.filter(d => (d.pnl_usd ?? 0) > 0);
  const lossDays = days.filter(d => (d.pnl_usd ?? 0) < 0);
  const flatDays = days.filter(d => (d.pnl_usd ?? 0) === 0);
  const dayPnlValues = days.map(d => d.pnl_usd ?? 0);
  const bestIdx = dayPnlValues.indexOf(Math.max(...dayPnlValues));
  const worstIdx = dayPnlValues.indexOf(Math.min(...dayPnlValues));
  const totalTrades = days.reduce((s, d) => s + (d.trades_count ?? 0), 0);
  const totalWins = days.reduce((s, d) => s + (d.wins ?? 0), 0);
  const totalLosses = days.reduce((s, d) => s + (d.losses ?? 0), 0);
  const totalFees = days.reduce((s, d) => s + (d.fees_usd ?? 0), 0);
  const wrBase = totalWins + totalLosses;

  return {
    label,
    periodStart,
    periodEnd,
    days,
    empty: false,
    totalPnl: Number(totalPnl.toFixed(2)),
    avgDailyPnl: Number((totalPnl / days.length).toFixed(2)),
    daysCount: days.length,
    winDaysCount: winDays.length,
    lossDaysCount: lossDays.length,
    flatDaysCount: flatDays.length,
    dayWinRate: days.length ? Math.round((winDays.length / days.length) * 100) : 0,
    bestDay: days[bestIdx],
    worstDay: days[worstIdx],
    totalTrades,
    totalWins,
    totalLosses,
    tradeWinRate: wrBase ? Math.round((totalWins / wrBase) * 100) : 0,
    totalFees: Number(totalFees.toFixed(2)),
    avgPnlPerTrade: totalTrades ? Number((totalPnl / totalTrades).toFixed(2)) : 0,
  };
}

export function getWeeklyPnl(weeksAgo = 0) {
  const today = getWibDate();
  const weekStart = getWeekStartWibDate(addDaysToWibDate(today, -7 * weeksAgo));
  const weekEnd = addDaysToWibDate(weekStart, 6);
  const history = loadHistory();
  const days = history.filter(d => d.date >= weekStart && d.date <= weekEnd)
                      .sort((a, b) => a.date.localeCompare(b.date));
  return aggregateDays(days, "Weekly", weekStart, weekEnd);
}

export function getMonthlyPnl(monthsAgo = 0) {
  const today = getWibDate();
  const monthStart = getMonthStartWibDate(today, monthsAgo);
  // Compute month-end by taking the last day of that month.
  const [y, m] = monthStart.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-indexed; Date.UTC(y, m, 0) = last day of month m
  const monthEnd = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const history = loadHistory();
  const days = history.filter(d => d.date >= monthStart && d.date <= monthEnd)
                      .sort((a, b) => a.date.localeCompare(b.date));
  const agg = aggregateDays(days, "Monthly", monthStart, monthEnd);
  agg.monthLabel = getMonthLabel(monthStart);
  return agg;
}

export function getHistorySummary() {
  const h = loadHistory();
  const totalPnl = h.reduce((s, d) => s + (d.pnl_usd ?? 0), 0);
  return {
    daysTracked: h.length,
    earliest: h[0]?.date ?? null,
    latest: h[h.length - 1]?.date ?? null,
    cumulativePnlUsd: Number(totalPnl.toFixed(2)),
    retentionCap: RETENTION_DAYS,
  };
}

// Exposed for testing/maintenance.
export const _internals = { getWibDate, getWeekStartWibDate, getMonthStartWibDate, addDaysToWibDate, getWibDayOfWeek, parseWibDate };
