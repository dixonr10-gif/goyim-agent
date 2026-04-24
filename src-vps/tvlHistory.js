// src-vps/tvlHistory.js
// Track TVL per pool over a 24h sliding window, compute drain percentage
// across multiple lookbacks, and return a penalty score. Closes the blindspot
// surfaced by the ASTROID-SOL entry on 2026-04-22: pool TVL went $96k → $13k
// (86% LP exit) in one day but no existing filter noticed, because:
//   (1) Fee/TVL ratio RISES as TVL drops faster than fees decay — the
//       "hotter pool" signal is actually death
//   (2) Daily fee/TVL filter passes, rate-of-TVL-change isn't measured
//       anywhere
//
// In-memory only (no disk persist) — accepted tradeoff: ~1h after restart
// the 60-min lookback is blind; by 6h the 360-min lookback is back. Worth
// the simplicity vs managing restart-safe state.

import fs from "fs";
import path from "path";

const TVL_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24h
const TVL_HISTORY_MAX_POOLS = 2000;                  // memory cap
const TVL_DRAIN_EVENTS_FILE = path.resolve("data/tvl_drain_events.json");
const TVL_DRAIN_EVENTS_MAX = 500;                    // rolling log

const tvlHistory = new Map(); // poolAddress → [{ t: ms, tvl: number }]

export function updateTvlHistory(poolAddress, currentTvl) {
  if (!poolAddress || typeof currentTvl !== "number" || !Number.isFinite(currentTvl) || currentTvl < 0) return;

  const now = Date.now();
  let history = tvlHistory.get(poolAddress) || [];
  history.push({ t: now, tvl: currentTvl });
  // Prune entries older than 24h. Keeps history bounded per-pool regardless
  // of how often the pool is rescanned.
  history = history.filter(h => (now - h.t) < TVL_HISTORY_WINDOW_MS);
  tvlHistory.set(poolAddress, history);

  // Evict the pool whose newest datapoint is the oldest (i.e. least recently
  // scanned) if we've blown past the cap. This is O(n) but only runs on
  // overflow and the overflow set size is small.
  if (tvlHistory.size > TVL_HISTORY_MAX_POOLS) {
    let oldestPool = null;
    let oldestT = Infinity;
    for (const [p, h] of tvlHistory.entries()) {
      const lastT = h[h.length - 1]?.t ?? 0;
      if (lastT < oldestT) { oldestT = lastT; oldestPool = p; }
    }
    if (oldestPool) tvlHistory.delete(oldestPool);
  }
}

// Drain % relative to the PEAK TVL observed in [now - lookbackMin, now].
// Returns null when there isn't at least one datapoint older than the
// lookback window (so cold-start can't spuriously score anyone).
export function computeTvlDrainPct(poolAddress, lookbackMinutes = 60) {
  const history = tvlHistory.get(poolAddress);
  if (!history || history.length < 2) return null;
  const now = Date.now();
  const lookbackMs = lookbackMinutes * 60 * 1000;
  const olderOrEqual = history.filter(h => (now - h.t) >= lookbackMs);
  if (olderOrEqual.length === 0) return null;
  const referenceTvl = Math.max(...olderOrEqual.map(h => h.tvl));
  const currentTvl = history[history.length - 1].tvl;
  if (referenceTvl <= 0) return null;
  const drainPct = ((referenceTvl - currentTvl) / referenceTvl) * 100;
  return { drainPct, referenceTvl, currentTvl, lookbackMinutes, dataPoints: history.length };
}

// Worst-case drain across 1h/3h/6h windows → tiered penalty.
// Part 24 Edit 5 (Option B, loosened): ≥70% -30 CRITICAL (hard block),
// 60-69% -20 HIGH, 50-59% -10 MEDIUM, <50% no penalty.
export function computeTvlDrainPenalty(poolAddress) {
  const windows = [60, 180, 360];
  let worst = null;
  for (const win of windows) {
    const r = computeTvlDrainPct(poolAddress, win);
    if (r && (!worst || r.drainPct > worst.drainPct)) worst = r;
  }
  if (!worst) return { penalty: 0, reason: null, severity: null, drainPct: null };

  const { drainPct, referenceTvl, currentTvl, lookbackMinutes } = worst;
  const formatted = `TVL drain ${drainPct.toFixed(0)}% in ${lookbackMinutes}min ($${Math.round(referenceTvl)}→$${Math.round(currentTvl)})`;

  if (drainPct >= 70) return { penalty: -30, reason: `TVL collapsed ${drainPct.toFixed(0)}% in ${lookbackMinutes}min ($${Math.round(referenceTvl)}→$${Math.round(currentTvl)})`, severity: "CRITICAL", drainPct, referenceTvl, currentTvl, lookbackMinutes };
  if (drainPct >= 60) return { penalty: -20, reason: formatted, severity: "HIGH", drainPct, referenceTvl, currentTvl, lookbackMinutes };
  if (drainPct >= 50) return { penalty: -10, reason: formatted, severity: "MEDIUM", drainPct, referenceTvl, currentTvl, lookbackMinutes };
  return { penalty: 0, reason: null, severity: null, drainPct };
}

// Append-only, rolling-capped event log for post-hoc review.
export function recordTvlDrainEvent({ poolAddress, symbol, drainPct, lookbackMinutes, referenceTvl, currentTvl, penalty, severity }) {
  try {
    let log = [];
    if (fs.existsSync(TVL_DRAIN_EVENTS_FILE)) {
      try { log = JSON.parse(fs.readFileSync(TVL_DRAIN_EVENTS_FILE, "utf-8")); } catch {}
      if (!Array.isArray(log)) log = [];
    }
    log.push({
      timestamp: new Date().toISOString(),
      pool: poolAddress,
      symbol: symbol ?? null,
      drainPct: Number(drainPct?.toFixed?.(2) ?? 0),
      lookbackMinutes,
      referenceTvl: Math.round(referenceTvl ?? 0),
      currentTvl: Math.round(currentTvl ?? 0),
      penalty,
      severity,
    });
    fs.mkdirSync(path.dirname(TVL_DRAIN_EVENTS_FILE), { recursive: true });
    fs.writeFileSync(TVL_DRAIN_EVENTS_FILE, JSON.stringify(log.slice(-TVL_DRAIN_EVENTS_MAX), null, 2));
  } catch (err) {
    console.warn(`[TvlDrain] event-log write failed: ${err.message}`);
  }
}

// Snapshot (for /status-style inspection). Small by design — no per-datapoint dump.
export function getTvlHistorySnapshot() {
  return {
    poolCount: tvlHistory.size,
    cap: TVL_HISTORY_MAX_POOLS,
    windowHours: TVL_HISTORY_WINDOW_MS / 3_600_000,
  };
}

export function clearTvlHistory() { tvlHistory.clear(); }
