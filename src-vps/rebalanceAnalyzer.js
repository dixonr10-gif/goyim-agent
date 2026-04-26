// src-vps/rebalanceAnalyzer.js
// Part 19: Smart Rebalance Decision — analyze pool state before re-entering
// after an OOR close. Returns { action: ENTER|WAIT|SKIP, ... }.
//
// Previously the rebalance re-open was blind: wait 5min, re-open regardless
// of what the pool had done since. This caused ASTROID-like losses where the
// bot re-entered into an active drain/dump. Now we:
//   1. Fast-path SKIP on severe deterioration (no LLM, no cost)
//   2. Fast-path ENTER on clearly clean setups (no LLM, no cost)
//   3. Opus 4.7 handles the gray zone (~$0.05–0.10 per call)
//
// AGGRESSIVE strictness per Dixon: SKIP only on severe signals, favor capture.

import fs from "fs";
import path from "path";
import { computeTvlDrainPenalty } from "./tvlHistory.js";
import { fetchPoolStats, getEffectiveApr } from "./poolScanner.js";
import { getTokenAgeHours, classifyAgeTier, extractTokenMint } from "./tokenAge.js";
import { getCandles, getTASignal } from "./technicalAnalysis.js";
import { callLLMChat } from "./llmAgent.js";

const EVENTS_LOG = path.resolve("data/rebalance_decisions.json");
const EVENTS_CAP = 500;

export const REBALANCE_CONFIG = {
  MAX_RETRIES: 3,
  WAIT_TIMEOUT_MS: 10 * 60 * 1000, // 10 min between WAIT re-evaluations
  STRICTNESS: "AGGRESSIVE",
};

// Aggressive thresholds. SKIP fires only on severe deterioration; ENTER
// fast-paths clear setups; everything else falls through to the LLM.
const T = {
  SKIP_TVL_DRAIN_PCT: 70,        // critical drain
  SKIP_ACTIVE_DUMP_PATTERNS: new Set(["DUMPING"]),
  SKIP_H1_ACTIVE_DUMP_PCT: -15,  // h1 < -15% + dump pattern
  SKIP_FEE_APR_COLLAPSE_PCT: 70, // fee APR dropped ≥ 70% from entry
  // Age-tier YOLO hard-cut removed 2026-04-26 — replaced with score modifier
  // (Phase 2 redesign). LLM now decides based on total picture, not tier alone.
  ENTER_DRAIN_PCT_MAX: 20,       // < 20% drain OK
  ENTER_PATTERNS: new Set(["ACCUMULATING"]),
  ENTER_RSI_MAX: 55,             // oversold-to-neutral zone
  ENTER_FEE_APR_RATIO_MIN: 0.8,  // fee ≥ 80% of entry-time APR
};

// Mirror of hunterAgent.ageTierBonus — Phase 2 age tier scoring redesign.
// Tier as informational signal; magnitudes deliberately subtle (±5/±10).
function ageTierBonus(tier) {
  switch (tier) {
    case 'MATURE_>48h':    return +5;
    case 'CAUTION_24-48h': return  0;
    case 'DANGER_12-24h':  return -5;
    case 'YOLO_<12h':      return -10;
    case 'UNKNOWN':
    default:               return -10;
  }
}

// ── Enrichment ────────────────────────────────────────────────────────────
async function fetchDexScreenerPair(poolAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`, {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    return data?.pair ?? data?.pairs?.[0] ?? null;
  } catch { return null; }
}

// Mirrors analyzeChart() in hunterAgent.js — kept inline to avoid a circular
// import (positionManager→rebalanceAnalyzer→hunterAgent→positionManager).
function classifyPattern(pair) {
  if (!pair) return { pattern: "UNKNOWN", priceTrend: "SIDEWAYS", volumeTrend: "STABLE" };
  const m5 = parseFloat(pair.priceChange?.m5 ?? "0");
  const h1 = parseFloat(pair.priceChange?.h1 ?? "0");
  const h6 = parseFloat(pair.priceChange?.h6 ?? "0");
  const vol5m = pair.volume?.m5 ?? 0;
  const vol1h = pair.volume?.h1 ?? 0;
  const vol6h = pair.volume?.h6 ?? 0;

  let priceTrend = "SIDEWAYS";
  if (m5 > 1 && h1 > 2) priceTrend = "RISING";
  else if (m5 < -1 && h1 < -2) priceTrend = "FALLING";

  const proj5m = vol5m * 12;
  const proj6h = vol6h / 6;
  let volumeTrend = "STABLE";
  if (proj5m > vol1h * 1.3 && vol1h > proj6h * 1.3) volumeTrend = "INCREASING";
  else if (proj5m < vol1h * 0.7 && vol1h < proj6h * 0.7) volumeTrend = "DECREASING";

  let pattern = "UNKNOWN";
  if (h1 > 5 && h6 < 10 && volumeTrend === "INCREASING") pattern = "EARLY_PUMP";
  else if (h6 > 20 && (h1 < h6 * 0.5 || m5 < 0) && volumeTrend !== "INCREASING") pattern = "PUMP_EXHAUSTION";
  else if (h1 < -10 || (m5 < -3 && h1 < -5)) pattern = "DUMPING";
  else if (Math.abs(h1) < 5 && (volumeTrend === "STABLE" || volumeTrend === "INCREASING")) pattern = "ACCUMULATING";

  return { pattern, priceTrend, volumeTrend, m5, h1, h6 };
}

async function enrichPoolState(poolAddress) {
  const [meteora, pair] = await Promise.all([
    fetchPoolStats(poolAddress),            // TVL, fees24h, volume from Meteora datapi
    fetchDexScreenerPair(poolAddress),      // priceChange + pair for candle synth
  ]);
  if (!meteora && !pair) return null;

  const chart = classifyPattern(pair);

  // RSI from synthetic candles (same method Hunter uses)
  let rsi = null;
  try {
    if (pair) {
      const candles = await getCandles(poolAddress, pair);
      if (candles) {
        const ta = getTASignal(candles);
        if (typeof ta?.rsi === "number") rsi = ta.rsi;
      }
    }
  } catch {}

  // Age tier via Part 17 v2 (DexScreener pair primary, Helius fallback)
  let ageHours = null, ageTier = "UNKNOWN";
  try {
    const mint = meteora ? extractTokenMint({
      mint_x: meteora.token_x,
      mint_y: meteora.token_y,
      dexPair: pair,
    }) : pair?.baseToken?.address;
    if (mint) {
      const age = await getTokenAgeHours(mint, poolAddress);
      if (age && typeof age.ageHours === "number") {
        ageHours = age.ageHours;
        ageTier = classifyAgeTier(age.ageHours) ?? "UNKNOWN";
      }
    }
  } catch {}

  const tvl = meteora?.tvl ?? pair?.liquidity?.usd ?? 0;
  const feeApr = meteora ? getEffectiveApr(meteora) : 0;

  return {
    pool: poolAddress,
    tvl,
    feeApr: Number(feeApr) || 0,
    priceChange: {
      m5: chart.m5 ?? 0,
      h1: chart.h1 ?? 0,
      h6: chart.h6 ?? 0,
      h24: parseFloat(pair?.priceChange?.h24 ?? "0"),
    },
    pattern: chart.pattern,
    priceTrend: chart.priceTrend,
    volumeTrend: chart.volumeTrend,
    rsi,
    ageHours,
    ageTier,
    priceUsd: parseFloat(pair?.priceUsd ?? "0") || null,
  };
}

// ── Decision ──────────────────────────────────────────────────────────────

function buildDecision(action, rationale, confidence, { llmCalled = false, fastPath = null } = {}) {
  return { action, rationale, confidence, llmCalled, fastPath };
}

async function llmGrayZone(entry, state, drain, retryCount) {
  const minutesSinceClose = Math.max(0, Math.round((Date.now() - (entry.savedAt ?? Date.now())) / 60000));
  const feeAprAtEntry = Number(entry.feeAprAtEntry ?? entry.poolFeeApr ?? 0);
  const currentFeeApr = state.feeApr ?? 0;
  const feeDelta = currentFeeApr - feeAprAtEntry;

  const system = `You decide whether to re-enter a Meteora DLMM position after an out-of-range close.

DECISION FRAMEWORK (AGGRESSIVE MODE):
- ENTER: conditions acceptable to re-deploy
- WAIT: uncertain signals, re-evaluate in 10 min (retry ${retryCount}/${REBALANCE_CONFIG.MAX_RETRIES})
- SKIP: clear deterioration, abort re-open

SIGNALS TO WEIGH:
- TVL drain trap: rising Fee/TVL with draining TVL = death spiral (refuse)
- OOR_LEFT (token dumped) often stabilizes — rebound candidate
- OOR_RIGHT (token pumped) often retraces — higher re-entry risk
- Age tier: one of several inputs (already baked into pool score via ±5/±10 modifier; no tier auto-blocks)

Reply ONLY with JSON, no markdown:
{"action":"ENTER"|"WAIT"|"SKIP","confidence":0-100,"rationale":"2–3 specific signals"}`;

  const drainLine = drain.penalty < 0
    ? `\n⚠️ TVL DRAIN: ${drain.reason} [${drain.severity}] — LPs exiting, high Fee/TVL here is death`
    : "";

  const user = `POSITION CONTEXT:
- Token: ${entry.poolName ?? entry.symbol ?? "UNKNOWN"}
- Closed ${minutesSinceClose} min ago via ${entry.exitReason ?? "REBALANCE"}
- Retry: ${retryCount}/${REBALANCE_CONFIG.MAX_RETRIES}
- Entry feeApr: ${feeAprAtEntry ? feeAprAtEntry.toFixed(1) + "%" : "unknown"}

CURRENT POOL STATE:
- Price: m5=${state.priceChange.m5.toFixed(1)}% h1=${state.priceChange.h1.toFixed(1)}% h6=${state.priceChange.h6.toFixed(1)}% h24=${state.priceChange.h24.toFixed(1)}%
- Pattern: ${state.pattern} (${state.priceTrend} / vol ${state.volumeTrend})
- RSI: ${state.rsi != null ? state.rsi.toFixed(1) : "n/a"}
- TVL: $${Math.round(state.tvl)}
- TVL drain: ${drain.drainPct != null ? drain.drainPct.toFixed(0) : "0"}% [${drain.severity ?? "NONE"}]
- Fee APR now: ${currentFeeApr.toFixed(1)}%${feeAprAtEntry ? ` (delta ${feeDelta >= 0 ? "+" : ""}${feeDelta.toFixed(1)}%)` : ""}
- Age tier: ${state.ageTier}${state.ageHours != null ? ` (${state.ageHours.toFixed(1)}h)` : ""} [score modifier ${ageTierBonus(state.ageTier) >= 0 ? "+" : ""}${ageTierBonus(state.ageTier)}]${drainLine}

Decide: ENTER, WAIT, or SKIP.`;

  try {
    const raw = await callLLMChat({ system, user, modelKey: "smart", temperature: 0.2, maxTokens: 200 });
    const cleaned = (raw ?? "").replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no JSON in response");
    const parsed = JSON.parse(match[0]);
    const action = String(parsed.action ?? "").toUpperCase();
    if (!["ENTER", "WAIT", "SKIP"].includes(action)) throw new Error(`invalid action: ${parsed.action}`);
    return buildDecision(action, parsed.rationale ?? "no rationale", Number(parsed.confidence) || 50, { llmCalled: true });
  } catch (err) {
    // Failsafe: WAIT on LLM error so we retry next cycle rather than blindly ENTER or SKIP.
    return buildDecision("WAIT", `LLM error: ${err.message}. Permissive retry.`, 0, { llmCalled: true });
  }
}

export async function analyzeRebalance(entry, retryCount = 0) {
  // Cheap gates first — never call LLM if we don't need to.
  if (retryCount >= REBALANCE_CONFIG.MAX_RETRIES) {
    return buildDecision("SKIP", `Max retries (${retryCount}/${REBALANCE_CONFIG.MAX_RETRIES}) exceeded`, 100, { fastPath: "max_retries" });
  }

  const poolAddress = entry.pool ?? entry.poolAddress;
  if (!poolAddress) {
    return buildDecision("SKIP", "no pool address in entry", 100, { fastPath: "bad_entry" });
  }

  const drain = computeTvlDrainPenalty(poolAddress);
  if ((drain.drainPct ?? 0) >= T.SKIP_TVL_DRAIN_PCT || drain.severity === "CRITICAL") {
    return buildDecision("SKIP", `Critical TVL drain ${drain.drainPct?.toFixed(0) ?? "?"}% — ${drain.reason ?? "dying pool"}`, 100, { fastPath: "critical_drain" });
  }

  const state = await enrichPoolState(poolAddress);
  if (!state) {
    // Permissive: data unavailable → WAIT, don't block on infra flake
    return buildDecision("WAIT", "Pool state fetch failed — retry next cycle", 0, { fastPath: "data_fail" });
  }

  // Active-dump fast path
  if (T.SKIP_ACTIVE_DUMP_PATTERNS.has(state.pattern) && state.priceChange.h1 < T.SKIP_H1_ACTIVE_DUMP_PCT) {
    return buildDecision("SKIP", `Active dump: ${state.pattern} + h1 ${state.priceChange.h1.toFixed(1)}%`, 100, { fastPath: "active_dump" });
  }

  // Fee-APR collapse fast path (only if we know the entry APR)
  const feeAprAtEntry = Number(entry.feeAprAtEntry ?? entry.poolFeeApr ?? 0);
  if (feeAprAtEntry > 0) {
    const dropPct = ((feeAprAtEntry - state.feeApr) / feeAprAtEntry) * 100;
    if (dropPct >= T.SKIP_FEE_APR_COLLAPSE_PCT) {
      return buildDecision("SKIP", `Fee APR collapsed ${dropPct.toFixed(0)}% (${feeAprAtEntry.toFixed(1)}% → ${state.feeApr.toFixed(1)}%)`, 100, { fastPath: "fee_collapse" });
    }
  }

  // YOLO age-tier hard-cut removed 2026-04-26 — Phase 2 redesign converts
  // age into a score modifier (see ageTierBonus). LLM decides on total picture.

  // Clean-setup fast path (ENTER without LLM)
  const drainPct = drain.drainPct ?? 0;
  const feeAprRatio = feeAprAtEntry > 0 ? (state.feeApr / feeAprAtEntry) : 1;
  if (drainPct < T.ENTER_DRAIN_PCT_MAX
      && T.ENTER_PATTERNS.has(state.pattern)
      && (state.rsi == null || state.rsi < T.ENTER_RSI_MAX)
      && feeAprRatio >= T.ENTER_FEE_APR_RATIO_MIN) {
    const parts = [
      `drain ${drainPct.toFixed(0)}%`,
      state.pattern,
      state.rsi != null ? `RSI ${state.rsi.toFixed(0)}` : "RSI n/a",
      `fee ${(feeAprRatio * 100).toFixed(0)}% of entry`,
    ];
    return buildDecision("ENTER", `Clean: ${parts.join(" + ")}`, 90, { fastPath: "clean_conditions" });
  }

  // Gray zone → Opus 4.7
  return await llmGrayZone(entry, state, drain, retryCount);
}

// ── Event log ────────────────────────────────────────────────────────────

export function recordRebalanceDecision(entry, decision, outcome) {
  try {
    let log = [];
    if (fs.existsSync(EVENTS_LOG)) {
      try { log = JSON.parse(fs.readFileSync(EVENTS_LOG, "utf-8")); } catch {}
      if (!Array.isArray(log)) log = [];
    }
    log.push({
      timestamp: new Date().toISOString(),
      symbol: entry.poolName ?? entry.symbol ?? null,
      pool: entry.pool ?? entry.poolAddress ?? null,
      exitReason: entry.exitReason ?? "REBALANCE",
      action: decision.action,
      rationale: decision.rationale,
      confidence: decision.confidence,
      llmCalled: !!decision.llmCalled,
      fastPath: decision.fastPath ?? null,
      retryCount: entry.retryCount ?? 0,
      outcome, // "EXECUTED" | "DEFERRED" | "ABORTED"
    });
    fs.mkdirSync(path.dirname(EVENTS_LOG), { recursive: true });
    fs.writeFileSync(EVENTS_LOG, JSON.stringify(log.slice(-EVENTS_CAP), null, 2));
  } catch (err) {
    console.warn(`[SmartRebalance] event-log write failed: ${err.message}`);
  }
}
