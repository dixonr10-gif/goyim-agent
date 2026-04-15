// src-vps/hunterAgent.js
// Hunter Agent — scans pools, makes LLM entry decisions every 30 min

import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { scanPools, formatPoolsForLLM, fetchDexScreenerMeteora, getEffectiveApr } from "./poolScanner.js";
import { checkBundler } from "./bundlerChecker.js";
import { analyzePool } from "./marketAnalyzer.js";
import { agentDecide } from "./llmAgent.js";
import { openPosition, getOpenPositions, syncOnChainPositions, checkWalletBalance, getPositionValue, closePosition } from "./positionManager.js";
import { recordTradeOpen, recordTradeClose, getMemoryContextForLLM, isPoolBlacklisted, getFullStats } from "./tradeMemory.js";
import { getRecentLessonsForLLM } from "./postTradeAnalyzer.js";
import { maybeLearnPatterns, getPatternsForLLM } from "./patternLearner.js";
import { notifyPositionOpened, notifyPositionClosed, notifyAgentDecision, notifyError, notifyMessage, isAgentPaused, esc } from "./telegramBot.js";
import { autoSwapTokensToSOL } from "./autoSwap.js";
import { isOnCooldown, getCooldownRemaining, extractTokenSymbol, setCooldown, isBlockedByMaxCap } from "./cooldownManager.js";
import { isTokenBlacklisted, decayBlacklist } from "./blacklistManager.js";
import { checkSmartWalletOverlap } from "./smartWallets.js";
import { recordLastRun } from "./healthCheck.js";
import { recordHunterRunResult } from "./thresholdEvolver.js";
import { getPoolScoreAdjustment, recordPoolDeploy } from "./poolMemory.js";
import { getCandles, getTASignal } from "./technicalAnalysis.js";
import { isStrictHours, formatWIB, getWIBHour } from "./timeHelper.js";

let hunterIteration = 0;
let lowBalanceCooldownUntil = 0;
let strictLossCooldownUntil = 0;
let strictCooldownNotified = false;

const STRICT_COOLDOWN_FILE = path.resolve("data/strict_cooldown.json");

// Restore strict cooldown across PM2 restart
(function restoreStrictCooldown() {
  try {
    if (!fs.existsSync(STRICT_COOLDOWN_FILE)) return;
    const data = JSON.parse(fs.readFileSync(STRICT_COOLDOWN_FILE, "utf-8"));
    const until = Number(data?.until ?? 0);
    if (until > Date.now()) {
      strictLossCooldownUntil = until;
      console.log(`[Hunter] ⏰ Restored strict cooldown from disk: ${Math.ceil((until - Date.now())/60000)}m remaining`);
    } else {
      fs.unlinkSync(STRICT_COOLDOWN_FILE);
      console.log("[Hunter] Strict cooldown file expired — removed");
    }
  } catch (e) { console.warn("[Hunter] restoreStrictCooldown failed:", e.message); }
})();

const STABLE_TOKENS = ["USDC", "USDT", "DAI", "BUSD", "USDS", "USDH", "USDE", "PYUSD"];

function isStablePair(poolName) {
  const upper = poolName?.toUpperCase() ?? "";
  return STABLE_TOKENS.some(s => upper.includes(s));
}

async function fetchPriceChange1h(poolAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`, {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const pair = data?.pair ?? data?.pairs?.[0];
    const val = parseFloat(pair?.priceChange?.h1 ?? "NaN");
    return Number.isFinite(val) ? val : null;
  } catch { return null; }
}

async function fetchMultiTimeframePriceChange(poolAddress) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`, {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const pair = data?.pair ?? data?.pairs?.[0];
    if (!pair) return null;
    const m5 = parseFloat(pair.priceChange?.m5 ?? "NaN");
    const h1 = parseFloat(pair.priceChange?.h1 ?? "NaN");
    const h6 = parseFloat(pair.priceChange?.h6 ?? "NaN");
    const h24 = parseFloat(pair.priceChange?.h24 ?? "NaN");
    const priceUsd = parseFloat(pair.priceUsd ?? "NaN");
    return {
      m5: Number.isFinite(m5) ? m5 : null,
      h1: Number.isFinite(h1) ? h1 : null,
      h6: Number.isFinite(h6) ? h6 : null,
      h24: Number.isFinite(h24) ? h24 : null,
      priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
    };
  } catch { return null; }
}

async function fetchDexScreenerTrending() {
  const trendingPools = [];
  const seenTokens = new Set();
  try {
    // Fetch from both endpoints in parallel
    const [boostsRes, profilesRes] = await Promise.allSettled([
      fetch("https://api.dexscreener.com/token-boosts/top/v1", { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
      fetch("https://api.dexscreener.com/token-profiles/latest/v1", { signal: AbortSignal.timeout(10000) }).then(r => r.json()),
    ]);

    const tokens = [];
    for (const r of [boostsRes, profilesRes]) {
      if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
      for (const t of r.value) {
        if (t.chainId === "solana" && t.tokenAddress && !seenTokens.has(t.tokenAddress)) {
          seenTokens.add(t.tokenAddress);
          tokens.push(t.tokenAddress);
        }
      }
    }
    if (tokens.length === 0) return [];
    console.log(`  [DexTrending] Found ${tokens.length} Solana trending tokens`);

    // Batch lookup: find Meteora DLMM pools for each (max 30 to widen candidate set)
    for (const mint of tokens.slice(0, 50)) {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(8000) });
        const data = await res.json();
        const pairs = (data?.pairs ?? []).filter(p =>
          p.chainId === "solana" &&
          (p.dexId?.toLowerCase().includes("meteora")) &&
          p.pairAddress
        );
        if (pairs.length === 0) {
          const sym = data?.pairs?.[0]?.baseToken?.symbol ?? mint.slice(0, 8);
          console.log(`  [DexTrending] ${sym} trending tapi no Meteora pool, skip`);
          continue;
        }
        // Pick highest liquidity Meteora pair
        pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        const best = pairs[0];
        const symbol = best.baseToken?.symbol ?? "?";
        console.log(`  [DexTrending] ${symbol} trending → pool ${best.pairAddress.slice(0, 8)}... +10 bonus`);
        trendingPools.push({
          address: best.pairAddress,
          name: `${best.baseToken?.symbol ?? "?"}/${best.quoteToken?.symbol ?? "?"}`,
          tvl: best.liquidity?.usd ?? 0,
          volume: { "24h": best.volume?.h24 ?? 0 },
          apr: 0, // will be enriched by DexScreener later
          dexTrending: true,
        });
      } catch {}
    }
  } catch (e) {
    console.warn(`  [DexTrending] Fetch error: ${e.message}`);
  }
  return trendingPools;
}

async function analyzeChart(poolAddress, dexPair) {
  let pair = dexPair;
  if (!pair) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`, {
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      pair = data?.pair ?? data?.pairs?.[0];
    } catch { return null; }
  }
  if (!pair) return null;

  const priceUsd = parseFloat(pair.priceUsd ?? "0");
  if (!priceUsd || priceUsd <= 0) return null;

  const m5 = parseFloat(pair.priceChange?.m5 ?? "0");
  const h1 = parseFloat(pair.priceChange?.h1 ?? "0");
  const h6 = parseFloat(pair.priceChange?.h6 ?? "0");

  const vol5m = pair.volume?.m5 ?? 0;
  const vol1h = pair.volume?.h1 ?? 0;
  const vol6h = pair.volume?.h6 ?? 0;

  // Price trend from multi-timeframe price changes
  let priceTrend = "SIDEWAYS";
  if (m5 > 1 && h1 > 2) priceTrend = "RISING";
  else if (m5 < -1 && h1 < -2) priceTrend = "FALLING";

  // Volume trend: project all to 1h equivalent for comparison
  const proj5m = vol5m * 12;
  const proj6h = vol6h / 6;
  let volumeTrend = "STABLE";
  if (proj5m > vol1h * 1.3 && vol1h > proj6h * 1.3) volumeTrend = "INCREASING";
  else if (proj5m < vol1h * 0.7 && vol1h < proj6h * 0.7) volumeTrend = "DECREASING";

  // Pattern classification
  let pattern = "UNKNOWN";
  if (h1 > 5 && h6 < 10 && volumeTrend === "INCREASING") {
    pattern = "EARLY_PUMP";
  } else if (h6 > 20 && (h1 < h6 * 0.5 || m5 < 0) && volumeTrend !== "INCREASING") {
    pattern = "PUMP_EXHAUSTION";
  } else if (h1 < -10 || (m5 < -3 && h1 < -5)) {
    pattern = "DUMPING";
  } else if (Math.abs(h1) < 5 && (volumeTrend === "STABLE" || volumeTrend === "INCREASING")) {
    pattern = "ACCUMULATING";
  }

  // Approximate last 3 x 5min candle close prices for display
  const p3 = priceUsd;
  const p2 = priceUsd / (1 + m5 / 100);
  const p1 = p2 * (1 - Math.abs(m5) / 200);
  const last3Candles = `$${p1.toPrecision(4)} vol=$${Math.round(vol5m * 0.9)} → $${p2.toPrecision(4)} vol=$${Math.round(vol5m * 0.95)} → $${p3.toPrecision(4)} vol=$${Math.round(vol5m)}`;

  return { priceTrend, volumeTrend, pattern, last3Candles };
}

const DAILY_LOSS_LIMIT_SOL = 5;

function getDailyLossSol() {
  try {
    const { trades } = getFullStats();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    return (trades ?? [])
      .filter(t => t.closedAt && new Date(t.closedAt) >= todayStart && t.outcome === "loss")
      .reduce((sum, t) => sum + Math.abs((t.pnlPercent ?? 0) / 100 * (t.solDeployed ?? 0)), 0);
  } catch { return 0; }
}

export function getDailyLossInfo() {
  const loss = getDailyLossSol();
  return { lossSol: loss, limit: DAILY_LOSS_LIMIT_SOL, paused: loss >= DAILY_LOSS_LIMIT_SOL };
}

export async function runHunter() {
  // Stamp tick at the very top so health check sees Hunter ticking even when
  // gated below by pause/cooldown/low-balance early-returns (avoids false STALE alarm)
  recordLastRun("hunter");

  if (isAgentPaused()) { console.log("⏸️ [Hunter] paused"); return; }

  // Daily loss limit
  const dailyLoss = getDailyLossSol();
  if (dailyLoss >= DAILY_LOSS_LIMIT_SOL) {
    console.log(`[Hunter] Daily loss limit reached: ${dailyLoss.toFixed(2)}/${DAILY_LOSS_LIMIT_SOL} SOL — paused until 00:00 UTC`);
    return;
  }

  // Strict hours loss cooldown (2h pause after loss during 14-18 WIB)
  if (Date.now() < strictLossCooldownUntil) {
    const rem = Math.ceil((strictLossCooldownUntil - Date.now()) / 60_000);
    console.log(`[Hunter] ⏰ Strict loss cooldown: ${rem}m remaining (resume ${formatWIB(new Date(strictLossCooldownUntil))})`);
    return;
  } else if (strictLossCooldownUntil > 0 && !strictCooldownNotified) {
    strictCooldownNotified = true;
    strictLossCooldownUntil = 0;
    try { if (fs.existsSync(STRICT_COOLDOWN_FILE)) fs.unlinkSync(STRICT_COOLDOWN_FILE); } catch {}
    console.log(`[Hunter] ✅ Strict loss cooldown selesai — ${formatWIB()}`);
    try { await notifyMessage(`✅ <b>Loss Cooldown Selesai</b>\n\n⏰ ${formatWIB()}\nHunter aktif kembali!`); } catch {}
  }

  if (Date.now() < lowBalanceCooldownUntil) {
    const rem = Math.ceil((lowBalanceCooldownUntil - Date.now()) / 60_000);
    console.log(`[Hunter] Low balance cooldown: ${rem}m remaining`);
    return;
  }

  hunterIteration++;
  let hunterOpenedPosition = false;
  console.log(`\n${"═".repeat(55)}`);
  console.log(`🦅 Hunter Agent — Iteration #${hunterIteration}`);
  console.log(`⏰ ${new Date().toLocaleString()}`);
  console.log("═".repeat(55));

  try {
    // Decay expired blacklists (7d)
    try { decayBlacklist(); } catch {}

    // Learning systems (pattern discovery only — selfImprovingPrompt removed
    // due to brain-paralysis bug where evolved oppScore thresholds rejected
    // valid candidates).
    const { stats, trades: allTrades } = getFullStats();
    await maybeLearnPatterns(allTrades);

    // Strict hours loss cooldown: if loss in last 2h during strict hours → pause
    if (isStrictHours()) {
      console.log(`  ⏰ Strict hours aktif (${formatWIB()}) — SL:-4% TP:+4% Trail:-2% MinVol:$200k`);
      const twoHoursAgo = Date.now() - 2 * 3_600_000;
      const recentLoss = (allTrades ?? []).find(t =>
        t.closedAt && t.outcome === "loss" && new Date(t.closedAt).getTime() > twoHoursAgo
      );
      if (recentLoss) {
        strictLossCooldownUntil = Date.now() + 2 * 3_600_000;
        strictCooldownNotified = false;
        try {
          fs.mkdirSync(path.dirname(STRICT_COOLDOWN_FILE), { recursive: true });
          fs.writeFileSync(STRICT_COOLDOWN_FILE, JSON.stringify({ until: strictLossCooldownUntil, reason: recentLoss.poolName, setAt: new Date().toISOString() }, null, 2));
        } catch (e) { console.warn("[Hunter] persist strict cooldown failed:", e.message); }
        console.log(`  🛑 Loss detected in strict hours (${recentLoss.poolName}) — cooldown 2h until ${formatWIB(new Date(strictLossCooldownUntil))}`);
        try {
          await notifyMessage(
            `🛑 <b>Loss Cooldown Aktif!</b>\n\nAda loss di strict hours (${process.env.ACTIVE_HOURS_START ?? 14}-${process.env.ACTIVE_HOURS_END ?? 18} WIB)\nPool: ${esc(recentLoss.poolName)}\n🚫 Hunter pause 2 jam\n⏰ Resume: ${formatWIB(new Date(strictLossCooldownUntil))}`
          );
        } catch {}
        return;
      }
    }

    // Sync on-chain state
    await syncOnChainPositions();

    // Scan + filter pools
    const rawPools = await scanPools();

    // DexScreener trending: additional candidate source
    let trendingCount = 0;
    try {
      const trendingPools = await fetchDexScreenerTrending();
      const existingAddrs = new Set(rawPools.map(p => p.address));
      for (const tp of trendingPools) {
        if (!existingAddrs.has(tp.address)) {
          rawPools.push(tp);
          trendingCount++;
        }
      }
    } catch (e) { console.warn(`[DexTrending] Error: ${e.message}`); }

    // Meteora fee_tvl_ratio trending: third candidate source
    let feeRatioCount = 0;
    try {
      const feeRatioPools = await fetchDexScreenerMeteora();
      const existingAddrs2 = new Set(rawPools.map(p => p.address));
      for (const fp of feeRatioPools) {
        if (!existingAddrs2.has(fp.address)) {
          rawPools.push(fp);
          feeRatioCount++;
        }
      }
    } catch (e) { console.warn(`[FeeTVL] Error: ${e.message}`); }

    const meteoraCount = rawPools.length - trendingCount - feeRatioCount;
    console.log(`[Hunter] candidates: ${meteoraCount} from Meteora + ${trendingCount} from DexTrending + ${feeRatioCount} from fee_tvl_ratio = ${rawPools.length} total`);

    if (rawPools.length === 0) { console.log("😴 No qualifying pools."); return; }

    console.log("\n📍 Filtering pools...");
    const safePools = [];
    for (const pool of rawPools) {
      if (isPoolBlacklisted(pool.address)) { console.log(`  🚫 ${pool.name}: blacklisted`); continue; }
      if (config.skipStablePairs && isStablePair(pool.name)) {
        console.log(`  ⛔ Skip ${pool.name}: stable pair, low yield potential`);
        continue;
      }
      const check = await checkBundler(pool.address);
      if (check.safe) safePools.push({ ...pool, riskScore: check.riskScore });
      else console.log(`  ⛔ ${pool.name}: bundler risk (${check.riskScore})`);
    }
    if (safePools.length === 0) { console.log("⚠️ All pools filtered."); return; }

    // Cooldown filter: skip tokens traded in the last TOKEN_COOLDOWN_HOURS
    // Also enforces max-deploy cap (MAX_DEPLOY_PER_24H) independent of cooldown
    // expiry — stops the same token from being recycled >N times in 24h.
    console.log("\n⏳ Checking token cooldowns...");
    const readyPools = safePools.filter(pool => {
      const symbol = extractTokenSymbol(pool.name);
      if (symbol && isBlockedByMaxCap(symbol)) {
        console.log(`  ⏭️ Skip ${pool.name}: ${symbol} max-deploy cap hit for 24h`);
        return false;
      }
      if (symbol && isOnCooldown(symbol)) {
        console.log(`  ⏭️ Skip ${pool.name}: ${symbol} on cooldown (${getCooldownRemaining(symbol)} remaining)`);
        return false;
      }
      return true;
    });
    if (readyPools.length === 0) { console.log("⚠️ All pools on cooldown."); return; }

    // Blacklist filter: skip high-mcap altcoins
    const nonBlacklisted = readyPools.filter(pool => {
      const result = isTokenBlacklisted(pool.name);
      if (result.blacklisted) {
        console.log(`  🚫 Skip ${pool.name}: ${result.reason}`);
        return false;
      }
      return true;
    });
    if (nonBlacklisted.length === 0) { console.log("⚠️ All pools blacklisted."); return; }

    // Daily Fee/TVL pre-filter: prefer pool.fees["24h"] / tvl; fallback to
    // vol × binStep / tvl via getEffectiveApr. Value is in daily % (e.g. 8 = 8% per day).
    const MIN_FEE_APR = config.minFeeAprFilter ?? 7;
    const feeFiltered = nonBlacklisted.filter(pool => {
      const feeApr = getEffectiveApr(pool);
      const sym = (pool.name ?? "").split(/[-\/]/)[0];
      const source = (pool?.fees?.["24h"] ?? 0) > 0 ? "fees24h" : "computed";
      if (!feeApr || feeApr <= 0) {
        console.log(`  [PreFilter] ${sym} SKIP — Daily Fee/TVL null (no data)`);
        return false;
      }
      if (feeApr < MIN_FEE_APR) {
        console.log(`  [PreFilter] ${sym} SKIP — Daily Fee/TVL ${feeApr.toFixed(2)}% [${source}] < ${MIN_FEE_APR}%`);
        return false;
      }
      console.log(`  [PreFilter] ${sym} OK — Daily Fee/TVL ${feeApr.toFixed(2)}% [${source}]`);
      return true;
    });
    if (feeFiltered.length === 0) { console.log("⚠️ All pools below fee APR floor."); return; }

    // Filter out pools that already have open positions (same pool OR same token)
    const openPos = getOpenPositions();
    const openPoolAddrs = new Set(openPos.map(p => p.pool));
    const openTokenSyms = new Set(openPos.map(p => {
      const name = p.poolName ?? p.tokenSymbol ?? "";
      return name.split(/[-\/]/)[0]?.toUpperCase();
    }).filter(Boolean));

    const availablePools = feeFiltered.filter(p => {
      if (openPoolAddrs.has(p.address)) return false;
      const sym = (p.name ?? "").split(/[-\/]/)[0]?.toUpperCase();
      if (sym && openTokenSyms.has(sym)) {
        console.log(`  [Hunter] Skip ${p.name}: already have open position for ${sym}`);
        return false;
      }
      return true;
    });
    const filteredOutOpen = feeFiltered.length - availablePools.length;
    if (filteredOutOpen > 0) console.log(`  [Hunter] Filtered out ${filteredOutOpen} pool(s) — open positions/tokens`);
    if (availablePools.length === 0) { console.log("⚠️ All pools already have open positions."); return; }

    // ── Pre-LLM hard filters: pump exhaustion, crash, ATH ────────────────
    // These MUST run before LLM sees the pool list — LLM cannot override.
    // Primary source: pool.dexPair (from scanner enrichment).
    // Fallback: fetchMultiTimeframePriceChange API (for pools without dexPair).
    console.log("\n🔍 Pre-LLM momentum filters...");
    const preFilteredPools = [];
    for (const pool of availablePools) {
      const sym = (pool.name ?? "").split(/[-\/]/)[0];

      // Get price data: prefer dexPair (already cached), fallback to API
      let m5 = NaN, h1 = NaN, h6 = NaN, h24 = NaN, priceUsd = NaN;
      const dp = pool.dexPair;
      if (dp) {
        m5  = parseFloat(dp.priceChange?.m5 ?? "NaN");
        h1  = parseFloat(dp.priceChange?.h1 ?? "NaN");
        h6  = parseFloat(dp.priceChange?.h6 ?? "NaN");
        h24 = parseFloat(dp.priceChange?.h24 ?? "NaN");
        priceUsd = parseFloat(dp.priceUsd ?? "NaN");
      } else {
        try {
          const mtf = await fetchMultiTimeframePriceChange(pool.address);
          if (mtf) {
            m5 = mtf.m5 ?? NaN; h1 = mtf.h1 ?? NaN; h6 = mtf.h6 ?? NaN;
            h24 = mtf.h24 ?? NaN; priceUsd = mtf.priceUsd ?? NaN;
          }
        } catch {}
      }

      // h6 pump exhaustion (skip for tokens < 6h old)
      if (Number.isFinite(h6) && h6 > 170) {
        const _ca = pool.created_at ?? pool.createdAt ?? pool.creation_time ?? null;
        const _age = _ca ? (Date.now() - new Date(_ca).getTime()) / 3_600_000 : null;
        if (_age === null || _age >= 6) {
          console.log(`  [PreFilter] ${sym} SKIP — h6 +${h6.toFixed(0)}% > 170% (pump exhaustion)`);
          continue;
        }
      }
      // h6 massive dump check (more reliable than ATH calc for pump-dump tokens)
      if (Number.isFinite(h6) && h6 < -50) {
        console.log(`  [PreFilter] ${sym} SKIP — h6 ${h6.toFixed(0)}% (massive dump)`);
        continue;
      }
      // ATH dump filter: estimate 24h high from all timeframe snapshots, skip if down >= 70%
      if (Number.isFinite(priceUsd) && priceUsd > 0) {
        let estHigh = priceUsd;
        for (const pct of [m5, h1, h6, h24]) {
          if (Number.isFinite(pct) && pct !== 0) {
            const implied = priceUsd / (1 + pct / 100);
            if (implied > estHigh) estHigh = implied;
          }
        }
        const drop = (estHigh - priceUsd) / estHigh * 100;
        if (drop >= 70) {
          console.log(`  [PreFilter] ${sym} SKIP — down ${drop.toFixed(0)}% from 24h high ($${estHigh.toPrecision(3)} → $${priceUsd.toPrecision(3)})`);
          continue;
        }
      }

      // Cache parsed mtf for post-LLM strategy selection
      pool._mtf = {
        m5: Number.isFinite(m5) ? m5 : null,
        h1: Number.isFinite(h1) ? h1 : null,
        h6: Number.isFinite(h6) ? h6 : null,
        h24: Number.isFinite(h24) ? h24 : null,
        priceUsd: Number.isFinite(priceUsd) ? priceUsd : null,
      };
      preFilteredPools.push(pool);
    }
    console.log(`  [PreFilter] ${availablePools.length - preFilteredPools.length} pool(s) removed, ${preFilteredPools.length} passed`);
    if (preFilteredPools.length === 0) { console.log("⚠️ All pools failed momentum filters."); return; }

    // Market analysis
    console.log("\n📈 Analyzing pools...");
    const poolAnalyses = await Promise.all(preFilteredPools.map(analyzePool));
    poolAnalyses.forEach(a =>
      console.log(`  ${a.poolName}: score=${a.opportunityScore} | vol=${a.volatility.level} | trend=${a.trend.direction}`)
    );

    const formattedPools = formatPoolsForLLM(preFilteredPools);

    // TA enrichment (RSI + EMA20) for top candidates
    console.log("\n📊 Computing TA (RSI + EMA20)...");
    const taMap = new Map();
    const taCandidates = preFilteredPools.slice(0, 20);
    await Promise.all(taCandidates.map(async (pool) => {
      try {
        const candles = await getCandles(pool.address, pool.dexPair ?? null);
        if (candles) {
          const ta = getTASignal(candles);
          taMap.set(pool.address, ta);
          console.log(`  📊 ${pool.name}: RSI ${ta.rsi?.toFixed(1) ?? "?"} | EMA20 ${ta.ema20?.toFixed(6) ?? "?"} | ${ta.signal}`);
        } else {
          console.log(`  ⚠️ TA: No candle data for ${pool.name}, skipping TA filter`);
        }
      } catch (err) {
        console.log(`  ⚠️ TA error for ${pool.name}: ${err.message}`);
      }
    }));

    // Attach TA data to formatted pools for LLM prompt
    for (const fp of formattedPools) {
      fp.ta = taMap.get(fp.address) ?? null;
    }

    // OHLCV Chart analysis for top 10 candidates (by score)
    console.log("\n🕯️ Analyzing OHLCV charts (top 10)...");
    const chartCandidates = preFilteredPools.slice(0, 10);
    const chartMap = new Map();
    await Promise.all(chartCandidates.map(async (pool) => {
      try {
        const chart = await analyzeChart(pool.address, pool.dexPair ?? null);
        if (chart) {
          chartMap.set(pool.address, chart);
          console.log(`  🕯️ ${pool.name}: ${chart.pattern} | price=${chart.priceTrend} | vol=${chart.volumeTrend}`);
        }
      } catch (err) {
        console.log(`  ⚠️ Chart error for ${pool.name}: ${err.message}`);
      }
    }));

    // Attach chart analysis to formatted pools for LLM prompt
    for (const fp of formattedPools) {
      fp.chart = chartMap.get(fp.address) ?? null;
    }

    // LLM decision
    const decision = await agentDecide({
      pools: formattedPools,
      poolAnalyses,
      openPositions: getOpenPositions(),
      tradeMemoryContext: getMemoryContextForLLM(),
      lessonsContext: getRecentLessonsForLLM(8),
      patternsContext: getPatternsForLLM(),
    });

    // Smart wallet signal: boost confidence if 2+ tracked wallets are in the target pool
    if (decision.action === "open" && decision.targetPool) {
      try {
        const swSignals = await checkSmartWalletOverlap([decision.targetPool]);
        const signal = swSignals[decision.targetPool];
        if (signal && signal.count >= 2) {
          const boost = 20;
          console.log(`  📡 Smart wallet signal: ${signal.count} tracked wallets in pool → confidence +${boost}%`);
          decision.confidence = Math.min(100, (decision.confidence ?? 0) + boost);
          decision.rationale = `[SW+${boost}] ${decision.rationale}`;
        } else if (signal && signal.count === 1) {
          console.log(`  📡 Smart wallet signal: 1 tracked wallet in pool (no boost)`);
        }
      } catch (e) { console.warn("[smartWallets] check failed:", e.message); }
    }

    console.log("\n📊 Hunter Decision:");
    console.log(`  Action:     ${decision.action.toUpperCase()}`);
    console.log(`  Confidence: ${decision.confidence}%`);
    console.log(`  Score:      ${decision.opportunityScore ?? "N/A"}/100`);
    console.log(`  Rationale:  ${decision.rationale}`);
    if (decision.appliedRules?.length) console.log(`  Rules:      ${decision.appliedRules.join(" | ")}`);

    // Execute: close positions if LLM says so
    let llmClosedCount = 0;
    for (const posId of decision.positionsToClose ?? []) {
      const pos = getOpenPositions().find(p => p.id === posId);
      if (pos) {
        try {
          // Get pre-close position value (counts all bins: SOL + token)
          let preClosePnlPct = null;
          try {
            const currentValue = await getPositionValue(pos);
            if (currentValue && currentValue > 0 && pos.solDeployed > 0) {
              preClosePnlPct = ((currentValue - pos.solDeployed) / pos.solDeployed) * 100;
              console.log(`[PNL] Pre-close LLM: currentValue=${currentValue.toFixed(4)} SOL → pnl=${preClosePnlPct.toFixed(2)}%`);
            }
          } catch {}
          const result = await closePosition(posId, { reason: "LLM_DECISION", pnlPct: preClosePnlPct });
          const txSignatures = result?.txSignatures ?? [];
          const solReturned = result?.solReceived ?? pos.solDeployed;
          recordTradeClose({ positionId: posId, solReturned, preClosePnlPct, poolName: pos.poolName, solDeployed: pos.solDeployed, closeReason: "LLM_DECISION" });
          await notifyPositionClosed(posId, "LLM decision", txSignatures);
          llmClosedCount++;
        } catch (err) { console.error(`❌ LLM close failed for ${posId}:`, err.message); }
      }
    }
    if (llmClosedCount > 0) {
      console.log(`[Hunter] ${llmClosedCount} position(s) closed by LLM — running auto-swap...`);
      await autoSwapTokensToSOL(notifyMessage);
    }

    // Execute: open new position
    if (decision.action.toLowerCase() === "open" && decision.confidence >= 60) {
      const currentOpen = getOpenPositions().length;
      if (currentOpen >= config.maxOpenPositions) {
        console.log(`🛑 Max positions (${config.maxOpenPositions}) reached.`);
      } else {
        const balance = await checkWalletBalance();
        if (balance !== null && balance < config.minSolToOpen) {
          console.log(`💸 Insufficient SOL: ${balance.toFixed(4)} SOL (need ${config.minSolToOpen})`);
          lowBalanceCooldownUntil = Date.now() + 10 * 60_000;
        } else {
          const pool = formattedPools.find(p => p.address === decision.targetPool)
            ?? formattedPools.find(p => p.name === decision.targetPool)
            ?? formattedPools.find(p => p.name?.toLowerCase().replace("/", "-") === decision.targetPool?.toLowerCase().replace("/", "-"));

          if (!pool) {
            console.log(`⚠️ Pool not found: ${decision.targetPool}`);
          } else {
            decision.targetPool = pool.address;
            decision.poolName = pool.name;

            // DexScreener trending bonus
            const rawPool = nonBlacklisted.find(p => p.address === pool.address);
            if (rawPool?.dexTrending) {
              decision.confidence = Math.min(100, (decision.confidence ?? 0) + 10);
              console.log(`  [DexTrending] ${pool.name} is trending → confidence +10`);
            }

            // Strategy selection using cached _mtf from pre-LLM filter (no re-fetch).
            // Primary signal is 1h change; fall back to (5m × 12) as a rough proxy when
            // h1 is missing so DexTrending pools without full MTF data can still route
            // to BidAsk. BidAsk trigger relaxed to +2% (was +5%), upper cap +20%.
            const cachedMtf = rawPool?._mtf ?? null;
            const priceChange1h = cachedMtf?.h1 ?? null;
            const priceChange5m = cachedMtf?.m5 ?? null;
            let effective1h = priceChange1h;
            let proxyFrom5m = false;
            if (effective1h == null && typeof priceChange5m === "number") {
              effective1h = priceChange5m * 12;
              proxyFrom5m = true;
            }
            if (effective1h != null && effective1h >= 2 && effective1h <= 20) {
              decision.strategy = "bidask";
              const tag = proxyFrom5m ? " (proxy from 5m)" : "";
              console.log(`  [Strategy] BidAsk — 1h +${effective1h.toFixed(1)}%${tag}`);
            } else if (effective1h != null) {
              decision.strategy = "spot";
              const tag = proxyFrom5m ? " (proxy from 5m)" : "";
              console.log(`  [Strategy] Spot — 1h ${effective1h >= 0 ? "+" : ""}${effective1h.toFixed(1)}%${tag} (below threshold)`);
            } else {
              decision.strategy = "spot";
              console.log(`  [Strategy] Spot — 1h N/A (no momentum data)`);
            }

            // momentumSkip: set by scoring, poolMem, TA — gates the open path
            let momentumSkip = false;

            // ── Dynamic bin count based on volatility ──────────────────
            const absChange1h = Math.abs(priceChange1h ?? 0);
            let binCount;
            if (absChange1h < 5) binCount = 50;
            else if (absChange1h < 15) binCount = 70;
            else if (absChange1h < 30) binCount = 90;
            else binCount = 110;
            decision.binRange = binCount;
            console.log(`  [Bins] ${binCount} bins (1h change: ${(priceChange1h ?? 0) >= 0 ? "+" : ""}${(priceChange1h ?? 0).toFixed(1)}%)`);

            // ── Weighted scoring & position sizing ─────────────────────
            let dynamicSol = config.maxSolPerPosition;
            let totalScore = 0;
            try {
              const { extractTokenSymbol: extSym } = await import("./cooldownManager.js");
              const tokenSym = extSym(pool.name);

              // 1) Fee/TVL score (weight 20%)
              let feeScore = 30;
              try {
                const dailyFees = pool.fees24h ?? (pool.volume24h * (pool.feePct ?? 0.25) / 100) ?? 0;
                const tvl = pool.tvl ?? 1;
                const feeRatio = (dailyFees / tvl) * 100;
                if (feeRatio >= 10) feeScore = 100;
                else if (feeRatio >= 5) feeScore = 85;
                else if (feeRatio >= 2) feeScore = 70;
                else if (feeRatio >= 1) feeScore = 50;
                else feeScore = 30;
              } catch {}

              // 2) Volume trend score (weight 35%)
              const organic = rawPool?.organicScore ?? pool.organicScore ?? 50;
              const volScore = Math.min(100, organic + (rawPool?.uptrend ? 20 : 0));

              // 3) Price momentum score (weight 20%) + ATH filter
              let momentumScore = 50;
              let athSkip = false;
              try {
                const mtf = await fetchMultiTimeframePriceChange(pool.address);
                if (mtf) {
                  // Pump exhaustion: h6 > 170% → score 0, but skip for tokens < 6h old (h6 data unreliable)
                  const _createdAt = rawPool?.created_at ?? rawPool?.createdAt ?? rawPool?.creation_time ?? null;
                  const _ageHours = _createdAt ? (Date.now() - new Date(_createdAt).getTime()) / 3_600_000 : null;
                  if (mtf.h6 !== null && mtf.h6 > 170) {
                    if (_ageHours !== null && _ageHours < 6) {
                      console.log(`  [Momentum] ${pool.name}: token age ${_ageHours.toFixed(1)}h < 6h → pump exhaustion check skipped (h6=${mtf.h6.toFixed(0)}%)`);
                    } else {
                      console.log(`  [Momentum] ${pool.name}: token age ${_ageHours?.toFixed(1) ?? "?"}h → pump exhaustion applied (h6=${mtf.h6.toFixed(0)}%)`);
                      momentumScore = 0;
                    }
                  }
                  if (momentumScore > 0 && mtf.m5 !== null && mtf.h1 !== null) {
                    if (mtf.m5 > 0 && mtf.h1 > 0) momentumScore = 80;
                    else if (mtf.m5 < 0 && mtf.h1 > 0) momentumScore = 60;
                    else if (mtf.m5 > 0 && mtf.h1 < 0) momentumScore = 40;
                    else momentumScore = 20;
                  }

                  // ATH proximity: estimate distance from 24h high
                  // If h24 is strongly positive and h1 still positive → near ATH
                  if (mtf.h24 !== null && mtf.h1 !== null) {
                    // Approximate: if token up 30% in 24h and up 5% in 1h, it's near the top
                    // distanceFromHigh ≈ how much it dropped from peak in 24h window
                    const recentDrop = Math.max(0, (mtf.h24 - mtf.h1)); // rough proxy
                    const nearATH = mtf.h24 > 20 && mtf.h1 > 0 && mtf.h1 > mtf.h24 * 0.3;
                    if (nearATH) {
                      console.log(`  [ATH] ${pool.name}: near 24h high (h24=+${mtf.h24.toFixed(0)}% h1=+${mtf.h1.toFixed(0)}%) → skip`);
                      athSkip = true;
                      momentumSkip = true;
                    } else if (mtf.h24 > 50 && mtf.h1 > -5) {
                      momentumScore = Math.max(0, momentumScore - 10);
                    } else if (mtf.h24 < -20) {
                      momentumScore = Math.max(0, momentumScore + 5);
                    }
                  }
                }
              } catch {}

              // 4) Other metrics score (weight 25%)
              const poolAnalysis = poolAnalyses.find(a => a.poolAddress === pool.address || a.poolName === pool.name);
              const opportunity = poolAnalysis?.opportunityScore ?? decision.opportunityScore ?? 50;
              const otherScore = Math.min(100, opportunity);

              // Weighted total
              const rawScore = Math.round(
                feeScore * 0.20 +
                volScore * 0.35 +
                momentumScore * 0.20 +
                otherScore * 0.25
              );
              totalScore = rawScore;

              // 5) Pool memory adjustment — capped so a bad-streak pool can't
              // single-handedly collapse a 70+ weighted score below the tier floor.
              // PoolMem floor: -20. Combined negative adjustment floor: -40.
              const poolMem = getPoolScoreAdjustment(pool.address);
              if (poolMem.mem) {
                console.log(`  📚 Pool memory: ${poolMem.mem.deployCount}x deploy, WR ${poolMem.mem.winRate ?? "?"}%, avg ${poolMem.mem.avgPnlPct >= 0 ? "+" : ""}${poolMem.mem.avgPnlPct}%`);
              }
              let poolMemAdj = 0;
              if (poolMem.adjustment === -999) {
                console.log(`  📚 [PoolMem] SKIP: ${poolMem.reason}`);
                momentumSkip = true;
              } else if (poolMem.adjustment !== 0) {
                poolMemAdj = poolMem.adjustment;
                if (poolMemAdj < -20) {
                  console.log(`  📚 [PoolMem] raw ${poolMemAdj} capped at -20 (${poolMem.reason})`);
                  poolMemAdj = -20;
                } else {
                  console.log(`  📚 [PoolMem] score ${poolMemAdj > 0 ? "+" : ""}${poolMemAdj} (${poolMem.reason})`);
                }
              }
              // Downtrend isn't a separate deduction today (volScore just doesn't add +20
              // when uptrend is false), but the slot is explicit so the combined floor
              // is applied uniformly and any future downtrend-specific penalty plugs in here.
              const downtrendAdj = 0;
              let combinedAdj = poolMemAdj + downtrendAdj;
              if (combinedAdj < -40) combinedAdj = -40;
              totalScore = Math.max(0, Math.min(100, rawScore + combinedAdj));

              console.log(`  [Score] ${pool.name}: fee=${feeScore} vol=${volScore} momentum=${momentumScore} other=${otherScore} → raw=${rawScore} downtrend=${downtrendAdj} poolMem=${poolMemAdj} final=${totalScore}/100`);

              // Pattern-learner (patterns.json) found the sweet spot is confidence ≥ 78
              // AND oppScore ≥ 85 → 52-58% WR. Let such candidates bypass the < 40 floor
              // at bottom tier (4 SOL) instead of skipping them outright.
              const confidence = decision.confidence ?? 0;
              const oppScore = decision.opportunityScore ?? opportunity ?? otherScore ?? 0;
              const patternMatched = confidence >= 78 && oppScore >= 85;

              if (totalScore > 85) dynamicSol = 8;
              else if (totalScore >= 75) dynamicSol = 7;
              else if (totalScore >= 65) dynamicSol = 6;
              else if (totalScore >= 50) dynamicSol = 5;
              else if (totalScore >= 40) dynamicSol = 4;
              else if (patternMatched) {
                dynamicSol = 4;
                console.log(`  [PatternMatch] ${tokenSym ?? pool.name} score=${totalScore} < 40 but confidence=${confidence} opp=${oppScore} → pattern-match, trading 4 SOL`);
              }
              else { dynamicSol = 0; momentumSkip = true; console.log(`  [PositionSize] score=${totalScore} < 40 → SKIP`); }

              dynamicSol = Math.min(dynamicSol, config.maxSolPerPosition);
              console.log(`  [PositionSize] ${tokenSym ?? "?"} score=${totalScore} (organic=${organic} opp=${opportunity}) → ${dynamicSol} SOL`);
            } catch {}

            // ── TA filter (RSI + EMA20) before opening ──────────────
            if (!momentumSkip) {
              let ta = taMap.get(pool.address);
              if (!ta) {
                try {
                  const rawPoolData = nonBlacklisted.find(p => p.address === pool.address);
                  const candles = await getCandles(pool.address, rawPoolData?.dexPair ?? null);
                  if (candles) ta = getTASignal(candles);
                  else console.log(`  ⚠️ TA: No candle data for ${pool.name}, skipping TA filter`);
                } catch {}
              }
              if (ta && ta.signal === "SKIP") {
                console.log(`  ⛔ TA Skip: ${pool.name} — ${ta.reason}`);
                momentumSkip = true;
              } else if (ta) {
                console.log(`  📊 TA: RSI ${ta.rsi.toFixed(1)} | EMA20 ${ta.ema20.toFixed(6)} | ${ta.signal}`);
                decision.ta = ta;
              }
            }

            if (!momentumSkip && decision.confidence >= 60) {
            // Skip if same pool address already has an open (non-mock) position
            const existing = getOpenPositions().find(p => p.pool === pool.address && !p.mock);
            if (existing) {
              console.log(`⛔ Skip: pool ${pool.address.slice(0,8)}... already has open position (${existing.id})`);
            } else {
            // Last-gate blacklist check — catches tokens blacklisted after initial filter
            const lastGateBL = isTokenBlacklisted(pool.name);
            if (lastGateBL.blacklisted) {
              console.log(`⛔ Blocked: ${pool.name} is blacklisted (last-gate check) — ${lastGateBL.reason}`);
            } else {
            const origMax = config.maxSolPerPosition;
            try {
              config.maxSolPerPosition = dynamicSol;
              const posId = await openPosition(decision);
              config.maxSolPerPosition = origMax;
              const newPos = getOpenPositions().find(p => p.id === posId);
              recordTradeOpen({
                positionId: posId,
                pool: decision.targetPool,
                poolName: pool.name ?? "unknown",
                strategy: decision.strategy,
                solDeployed: dynamicSol,
                positionAddress: newPos?.positionAddress,
                entryTokenPrice: newPos?.entryTokenPrice,
                binRange: newPos?.binRange ?? null,
                decision,
                poolTvl: pool.tvl ?? null,
                poolVolume24h: pool.volume?.["24h"] ?? null,
                poolFeeApr: getEffectiveApr(rawPool ?? pool) || (parseFloat(pool.feeApr) || null),
                organicScore: pool.organicScore ?? null,
              });
              recordPoolDeploy(decision.targetPool, { poolName: pool.name, strategy: decision.strategy, solDeployed: dynamicSol });
              if (newPos) { hunterOpenedPosition = true; await notifyPositionOpened(newPos, decision); }
            } catch (err) {
              config.maxSolPerPosition = origMax;
              const msg = err.message ?? "unknown error";
              const isFilterRejection =
                msg.includes("Token tidak viable") || msg.includes("tidak ada SOL") ||
                msg.includes("stable") || msg.includes("blacklist") ||
                msg.includes("Too old") || msg.includes("Too new") ||
                msg.includes("Vol too") || msg.includes("Wash trading") ||
                msg.includes("Liq too") || msg.includes("rug risk") ||
                msg.includes("Pool not DLMM");

              if (isFilterRejection) {
                console.log(`  ⏭️ Skip: ${msg.slice(0, 80)}`);
              } else if (msg.includes("SOL tidak cukup")) {
                console.log(`  💸 ${msg}`);
                lowBalanceCooldownUntil = Date.now() + 10 * 60_000;
              } else {
                console.log(`  [Hunter] open error: ${msg.slice(0, 100)}`);
                const sym = extractTokenSymbol(pool.name);
                if (sym) { setCooldown(sym); console.log(`  ⏱️ Cooldown set for ${sym} after TX failure`); }
                await notifyError(`[Hunter] ${msg.slice(0, 100)}`);
              }
            }
            } // end else (not blacklisted last-gate)
            } // end else (no existing position)
            } // end if (!momentumSkip && confidence >= 60)
          }
        }
      }
    }

    await notifyAgentDecision(decision);

    const final = getOpenPositions();
    console.log(`\n📋 Positions: ${final.length}/${config.maxOpenPositions}`);
    final.forEach(p => console.log(`  • ${p.id} | ${p.pool?.slice(0, 8)}... | ${p.strategy} | ${p.solDeployed} SOL`));

  } catch (err) {
    console.error("\n🔥 Hunter error:", err.message);
    if (!err.message?.includes("Max positions") && !err.message?.includes("SOL tidak cukup")) {
      await notifyError(`[Hunter] ${err.message}`);
    }
  }
  try { recordHunterRunResult(hunterOpenedPosition); } catch {}
  recordLastRun("hunter");
}
