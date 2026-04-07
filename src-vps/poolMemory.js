// src/poolMemory.js
// Tracks per-pool performance history for smarter entry decisions

import fs from "fs";
import path from "path";

const MEMORY_FILE = path.resolve("data/pool_memory.json");

function load() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8")); } catch { return {}; }
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

export function recordPoolDeploy(poolAddress, { poolName, strategy, solDeployed, openedAt }) {
  if (!poolAddress) return;
  const mem = load();
  if (!mem[poolAddress]) {
    mem[poolAddress] = { poolName, deployCount: 0, wins: 0, losses: 0, avgHoldMinutes: 0, avgPnlPct: 0, lastDeployedAt: null, history: [] };
  }
  mem[poolAddress].poolName = poolName ?? mem[poolAddress].poolName;
  mem[poolAddress].deployCount++;
  mem[poolAddress].lastDeployedAt = openedAt ?? new Date().toISOString();
  mem[poolAddress].history.push({
    openedAt: openedAt ?? new Date().toISOString(),
    closedAt: null,
    pnlPct: null,
    outcome: null,
    strategy: strategy ?? "spot",
    solDeployed: solDeployed ?? 0,
  });
  // Keep last 20 entries
  if (mem[poolAddress].history.length > 20) {
    mem[poolAddress].history = mem[poolAddress].history.slice(-20);
  }
  save(mem);
}

export function recordPoolClose(poolAddress, pnlPct, outcome, holdMinutes) {
  if (!poolAddress) return;
  const mem = load();
  const pool = mem[poolAddress];
  if (!pool) return;

  // Update the last unclosed history entry
  const lastOpen = [...pool.history].reverse().find(h => !h.closedAt);
  if (lastOpen) {
    lastOpen.closedAt = new Date().toISOString();
    lastOpen.pnlPct = pnlPct;
    lastOpen.outcome = outcome;
  }

  // Update aggregate stats
  if (outcome === "win") pool.wins++;
  else if (outcome === "loss") pool.losses++;

  const closedHistory = pool.history.filter(h => h.closedAt && h.pnlPct !== null);
  if (closedHistory.length > 0) {
    pool.avgPnlPct = parseFloat((closedHistory.reduce((a, h) => a + (h.pnlPct ?? 0), 0) / closedHistory.length).toFixed(2));
  }
  if (typeof holdMinutes === "number") {
    const prevTotal = (pool.avgHoldMinutes ?? 0) * Math.max(0, closedHistory.length - 1);
    pool.avgHoldMinutes = parseFloat(((prevTotal + holdMinutes) / closedHistory.length).toFixed(1));
  }

  save(mem);
}

export function getPoolMemory(poolAddress) {
  if (!poolAddress) return null;
  const mem = load();
  const pool = mem[poolAddress];
  if (!pool || pool.deployCount === 0) return null;

  const decided = pool.wins + pool.losses;
  const winRate = decided > 0 ? parseFloat(((pool.wins / decided) * 100).toFixed(1)) : null;
  const lossStreak = getLossStreak(pool.history);

  return {
    ...pool,
    winRate,
    lossStreak,
    decided,
  };
}

function getLossStreak(history) {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].outcome === "loss") streak++;
    else break;
  }
  return streak;
}

export function getPoolScoreAdjustment(poolAddress) {
  const mem = getPoolMemory(poolAddress);
  if (!mem || mem.decided < 2) return { adjustment: 0, reason: null, mem: null };

  if (mem.lossStreak >= 2) {
    return { adjustment: -999, reason: `loss streak ${mem.lossStreak}x`, mem };
  }
  if (mem.winRate > 60) {
    return { adjustment: 5, reason: `WR ${mem.winRate}%`, mem };
  }
  if (mem.winRate < 30) {
    return { adjustment: -10, reason: `WR ${mem.winRate}%`, mem };
  }
  return { adjustment: 0, reason: null, mem };
}
