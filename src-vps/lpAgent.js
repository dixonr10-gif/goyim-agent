// src/lpAgent.js — LPAgent API client for accurate on-chain PnL data
// Used for dashboard/reporting only. SL/TP execution stays on Meteora SDK.

import { config } from "../config.js";
import { getWalletAddress } from "./walletInfo.js";

const BASE = "https://api.lpagent.io/open-api/v1";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const _cache = {
  overview: { data: null, ts: 0 },
  opening:  { data: null, ts: 0 },
};

function getKey() {
  return config.lpagentApiKey || process.env.LPAGENT_API_KEY || "";
}

async function fetchLP(path) {
  const key = getKey();
  if (!key) throw new Error("LPAGENT_API_KEY not set");
  const wallet = await getWalletAddress();
  const res = await fetch(`${BASE}/${path}?owner=${wallet}`, {
    headers: { "x-api-key": key, "Accept": "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`LPAgent ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── Overview: wallet-level stats ───────────────────────────────────────
export async function getOverview() {
  if (Date.now() - _cache.overview.ts < CACHE_TTL && _cache.overview.data) {
    return _cache.overview.data;
  }
  const json = await fetchLP("lp-positions/overview");
  const d = json?.data?.[0];
  if (!d) throw new Error("No overview data");
  _cache.overview = { data: d, ts: Date.now() };
  return d;
}

// ── Open positions with real-time PnL ──────────────────────────────────
export async function getOpenPositionsLP() {
  if (Date.now() - _cache.opening.ts < CACHE_TTL && _cache.opening.data) {
    return _cache.opening.data;
  }
  const json = await fetchLP("lp-positions/opening");
  const positions = json?.data ?? [];
  _cache.opening = { data: positions, ts: Date.now() };
  return positions;
}

// ── Aggregated stats for a period ──────────────────────────────────────
export async function getStats(period = "allTime") {
  const ov = await getOverview();
  const key = period === "7d" ? "7D" : "ALL";

  return {
    totalPnlUsd:   ov.total_pnl?.[key]         ?? 0,
    totalPnlSol:   ov.total_pnl_native?.[key]  ?? 0,
    totalFeesUsd:  ov.total_fee?.[key]          ?? 0,
    totalFeesSol:  ov.total_fee_native?.[key]   ?? 0,
    winRate:       ((ov.win_rate?.[key] ?? 0) * 100).toFixed(1),
    winRateSol:    ((ov.win_rate_native?.[key] ?? 0) * 100).toFixed(1),
    totalTrades:   ov.closed_lp?.[key]          ?? 0,
    openPositions: ov.opening_lp                ?? 0,
    avgHoldHours:  ov.avg_age_hour              ?? 0,
    totalPools:    ov.total_pool                ?? 0,
    totalInflow:   ov.total_inflow              ?? 0,
    totalOutflow:  ov.total_outflow             ?? 0,
    expectedValue: ov.expected_value?.[key]     ?? 0,
    firstActivity: ov.first_activity,
    lastActivity:  ov.last_activity,
    source: "lpagent",
  };
}

export function clearLPAgentCache() {
  _cache.overview = { data: null, ts: 0 };
  _cache.opening  = { data: null, ts: 0 };
}
