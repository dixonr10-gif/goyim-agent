// src/meteoraPnl.js — PnL from Meteora datapi (source of truth)
import { getWalletAddress } from "./walletInfo.js";

const BASE = "https://dlmm.datapi.meteora.ag";

// ── Cache ────────────────────────────────────────────────────────────
const cache = { data: null, fetchedAt: 0 };
const CACHE_TTL = 300_000; // 5 minutes

// ── a) Get Portfolio PnL (all pools, paginated) ─────────────────────
export async function getPortfolioPnl() {
  if (cache.data && Date.now() - cache.fetchedAt < CACHE_TTL) return cache.data;

  const wallet = await getWalletAddress();
  const allPools = [];
  let page = 1;

  while (page <= 5) {
    try {
      const res = await fetch(`${BASE}/portfolio?user=${wallet}&pageSize=50&page=${page}`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { console.log(`[MeteoraPnl] HTTP ${res.status} page ${page}`); break; }
      const data = await res.json();
      allPools.push(...(data.pools ?? []));
      if (!data.hasNext) break;
      page++;
    } catch (err) {
      console.log(`[MeteoraPnl] Fetch error: ${err.message}`);
      break;
    }
  }

  const pools = allPools.map(p => ({
    poolAddress: p.poolAddress,
    tokenX: p.tokenX,
    tokenY: p.tokenY,
    pnlUsd: parseFloat(p.pnlUsd ?? 0),
    pnlSol: parseFloat(p.pnlSol ?? 0),
    pnlPctChange: parseFloat(p.pnlPctChange ?? 0),
    totalDeposit: parseFloat(p.totalDeposit ?? 0),
    totalWithdrawal: parseFloat(p.totalWithdrawal ?? 0),
    totalFee: parseFloat(p.totalFee ?? 0),
    totalFeeSol: parseFloat(p.totalFeeSol ?? 0),
    lastClosedAt: p.lastClosedAt ? new Date(p.lastClosedAt * 1000) : null,
  }));

  console.log(`[MeteoraPnl] Fetched ${pools.length} pools`);
  cache.data = pools;
  cache.fetchedAt = Date.now();
  return pools;
}

// ── b) Get Position PnL (per pool, closed) ──────────────────────────
export async function getPositionPnl(poolAddress, status = "closed") {
  const wallet = await getWalletAddress();
  try {
    const res = await fetch(
      `${BASE}/positions/${poolAddress}/pnl?user=${wallet}&status=${status}&pageSize=100&page=1`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.positions ?? []).map(p => ({
      positionAddress: p.positionAddress,
      pnlUsd: parseFloat(p.pnlUsd ?? 0),
      pnlPctChange: parseFloat(p.pnlPctChange ?? 0),
      depositUsd: parseFloat(p.allTimeDeposits?.total?.usd ?? 0),
      withdrawalUsd: parseFloat(p.allTimeWithdrawals?.total?.usd ?? 0),
      feesUsd: parseFloat(p.allTimeFees?.total?.usd ?? 0),
      createdAt: p.createdAt ? new Date(p.createdAt * 1000) : null,
      closedAt: p.closedAt ? new Date(p.closedAt * 1000) : null,
      isOutOfRange: p.isOutOfRange ?? false,
    }));
  } catch (err) {
    console.log(`[MeteoraPnl] Position PnL error: ${err.message}`);
    return [];
  }
}

// ── c) Get Portfolio Stats (aggregated, filtered by period) ─────────
export async function getPortfolioStats(period = "weekly") {
  const pools = await getPortfolioPnl();
  if (pools.length === 0) return null;

  const now = new Date();
  let startDate;
  if (period === "daily") {
    startDate = new Date(now); startDate.setUTCHours(0, 0, 0, 0);
  } else if (period === "weekly") {
    startDate = new Date(now.getTime() - 7 * 86400000); startDate.setUTCHours(0, 0, 0, 0);
  } else {
    startDate = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
  }

  // Filter pools by lastClosedAt (or include open positions for "daily")
  const filtered = pools.filter(p => {
    if (!p.lastClosedAt) return period === "daily"; // open positions count for daily
    return p.lastClosedAt >= startDate;
  });

  const wins = filtered.filter(p => p.pnlUsd > 0);
  const losses = filtered.filter(p => p.pnlUsd < 0);
  const totalPnlUsd = filtered.reduce((s, p) => s + p.pnlUsd, 0);
  const totalPnlSol = filtered.reduce((s, p) => s + p.pnlSol, 0);
  const totalFeesUsd = filtered.reduce((s, p) => s + p.totalFee, 0);
  const totalFeesSol = filtered.reduce((s, p) => s + p.totalFeeSol, 0);

  // Group by date for calendar
  const dayMap = {};
  for (const p of filtered) {
    const dateStr = p.lastClosedAt
      ? p.lastClosedAt.toISOString().slice(0, 10)
      : now.toISOString().slice(0, 10);
    if (!dayMap[dateStr]) dayMap[dateStr] = { date: dateStr, pnlUsd: 0, positions: 0, wins: 0, losses: 0 };
    dayMap[dateStr].pnlUsd += p.pnlUsd;
    dayMap[dateStr].positions++;
    if (p.pnlUsd > 0) dayMap[dateStr].wins++;
    if (p.pnlUsd < 0) dayMap[dateStr].losses++;
  }
  const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

  const best = filtered.length > 0 ? filtered.reduce((a, b) => a.pnlUsd > b.pnlUsd ? a : b) : null;
  const worst = filtered.length > 0 ? filtered.reduce((a, b) => a.pnlUsd < b.pnlUsd ? a : b) : null;

  return {
    period,
    startDate: startDate.toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
    totalPnlUsd,
    totalPnlSol,
    totalFeesUsd,
    totalFeesSol,
    totalPools: filtered.length,
    wins: wins.length,
    losses: losses.length,
    winRate: filtered.length > 0 ? ((wins.length / filtered.length) * 100).toFixed(0) : "0",
    days,
    bestPool: best ? { name: `${best.tokenX}-${best.tokenY}`, pnlUsd: best.pnlUsd } : null,
    worstPool: worst ? { name: `${worst.tokenX}-${worst.tokenY}`, pnlUsd: worst.pnlUsd } : null,
  };
}

export function clearMeteoraPnlCache() {
  cache.data = null;
  cache.fetchedAt = 0;
}
