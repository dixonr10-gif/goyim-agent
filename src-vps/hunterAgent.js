// src-vps/hunterAgent.js
// Hunter Agent — scans pools, makes LLM entry decisions every 30 min

import { config } from "../config.js";
import { scanPools, formatPoolsForLLM } from "./poolScanner.js";
import { checkBundler } from "./bundlerChecker.js";
import { analyzePool } from "./marketAnalyzer.js";
import { agentDecide } from "./llmAgent.js";
import { openPosition, getOpenPositions, syncOnChainPositions, checkWalletBalance, getPositionValue, closePosition } from "./positionManager.js";
import { recordTradeOpen, recordTradeClose, getMemoryContextForLLM, isPoolBlacklisted, getFullStats } from "./tradeMemory.js";
import { getRecentLessonsForLLM } from "./postTradeAnalyzer.js";
import { maybeLearnPatterns, getPatternsForLLM } from "./patternLearner.js";
import { maybeUpdateBrain, getBrainContextForLLM } from "./selfImprovingPrompt.js";
import { notifyPositionOpened, notifyPositionClosed, notifyAgentDecision, notifyError, notifyMessage, isAgentPaused } from "./telegramBot.js";
import { autoSwapTokensToSOL } from "./autoSwap.js";
import { isOnCooldown, getCooldownRemaining, extractTokenSymbol, setCooldown } from "./cooldownManager.js";
import { isTokenBlacklisted, decayBlacklist } from "./blacklistManager.js";
import { checkSmartWalletOverlap } from "./smartWallets.js";
import { recordLastRun } from "./healthCheck.js";
import { recordHunterRunResult } from "./thresholdEvolver.js";
import { getPoolScoreAdjustment, recordPoolDeploy } from "./poolMemory.js";

let hunterIteration = 0;
let lowBalanceCooldownUntil = 0;

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
    return {
      m5: Number.isFinite(m5) ? m5 : null,
      h1: Number.isFinite(h1) ? h1 : null,
      h6: Number.isFinite(h6) ? h6 : null,
      h24: Number.isFinite(h24) ? h24 : null,
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

    // Batch lookup: find Meteora DLMM pools for each (max 25 to widen candidate set)
    for (const mint of tokens.slice(0, 25)) {
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
  if (isAgentPaused()) { console.log("⏸️ [Hunter] paused"); return; }

  // Daily loss limit
  const dailyLoss = getDailyLossSol();
  if (dailyLoss >= DAILY_LOSS_LIMIT_SOL) {
    console.log(`[Hunter] Daily loss limit reached: ${dailyLoss.toFixed(2)}/${DAILY_LOSS_LIMIT_SOL} SOL — paused until 00:00 UTC`);
    return;
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

    // Learning systems
    const { stats, trades: allTrades } = getFullStats();
    await maybeUpdateBrain(stats);
    await maybeLearnPatterns(allTrades);

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
    const meteoraCount = rawPools.length - trendingCount;
    console.log(`[Hunter] candidates: ${meteoraCount} from Meteora + ${trendingCount} from DexTrending = ${rawPools.length} total`);

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
    console.log("\n⏳ Checking token cooldowns...");
    const readyPools = safePools.filter(pool => {
      const symbol = extractTokenSymbol(pool.name);
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

    // Filter out pools that already have open positions (same pool OR same token)
    const openPos = getOpenPositions();
    const openPoolAddrs = new Set(openPos.map(p => p.pool));
    const openTokenSyms = new Set(openPos.map(p => {
      const name = p.poolName ?? p.tokenSymbol ?? "";
      return name.split(/[-\/]/)[0]?.toUpperCase();
    }).filter(Boolean));

    const availablePools = nonBlacklisted.filter(p => {
      if (openPoolAddrs.has(p.address)) return false;
      const sym = (p.name ?? "").split(/[-\/]/)[0]?.toUpperCase();
      if (sym && openTokenSyms.has(sym)) {
        console.log(`  [Hunter] Skip ${p.name}: already have open position for ${sym}`);
        return false;
      }
      return true;
    });
    const filteredOutOpen = nonBlacklisted.length - availablePools.length;
    if (filteredOutOpen > 0) console.log(`  [Hunter] Filtered out ${filteredOutOpen} pool(s) — open positions/tokens`);
    if (availablePools.length === 0) { console.log("⚠️ All pools already have open positions."); return; }

    // Market analysis
    console.log("\n📈 Analyzing pools...");
    const poolAnalyses = await Promise.all(availablePools.map(analyzePool));
    poolAnalyses.forEach(a =>
      console.log(`  ${a.poolName}: score=${a.opportunityScore} | vol=${a.volatility.level} | trend=${a.trend.direction}`)
    );

    const formattedPools = formatPoolsForLLM(availablePools);

    // LLM decision
    const decision = await agentDecide({
      pools: formattedPools,
      poolAnalyses,
      openPositions: getOpenPositions(),
      tradeMemoryContext: getMemoryContextForLLM(),
      lessonsContext: getRecentLessonsForLLM(8),
      patternsContext: getPatternsForLLM(),
      brainContext: getBrainContextForLLM(),
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
          const result = await closePosition(posId);
          const txSignatures = result?.txSignatures ?? [];
          const solReturned = result?.solReceived ?? pos.solDeployed;
          recordTradeClose({ positionId: posId, solReturned, preClosePnlPct, poolName: pos.poolName, solDeployed: pos.solDeployed });
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

            // Dump filter — skip tokens already crashed
            const priceChange1h = await fetchPriceChange1h(pool.address);
            let momentumSkip = false;
            try {
              const mtfDump = await fetchMultiTimeframePriceChange(pool.address);
              if (mtfDump) {
                if (mtfDump.h6 !== null && mtfDump.h6 < -70) {
                  console.log(`  [DumpFilter] ${pool.name} dumped ${mtfDump.h6.toFixed(0)}% 6h → skip`);
                  momentumSkip = true;
                } else if (mtfDump.h1 !== null && mtfDump.h1 < -20) {
                  console.log(`  [DumpFilter] ${pool.name} dumping ${mtfDump.h1.toFixed(0)}% 1h → skip`);
                  momentumSkip = true;
                }
              }
            } catch {}

            // Momentum-based strategy selection
            if (!momentumSkip && priceChange1h !== null) {
              if (priceChange1h < -5) {
                console.log(`  [Strategy] SKIP - token turun ${priceChange1h.toFixed(1)}% 1h`);
                momentumSkip = true;
              } else if (priceChange1h > 2) {
                decision.strategy = "bidask";
                console.log(`  [Strategy] BidAsk dipilih - token naik +${priceChange1h.toFixed(1)}% 1h`);
              } else {
                decision.strategy = "spot";
                console.log(`  [Strategy] Spot dipilih - token sideways ${priceChange1h >= 0 ? "+" : ""}${priceChange1h.toFixed(1)}% 1h`);
              }
            }

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
                  if (mtf.h6 !== null && mtf.h6 > 200) momentumScore = 0;
                  else if (mtf.m5 !== null && mtf.h1 !== null) {
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
              totalScore = Math.round(
                feeScore * 0.20 +
                volScore * 0.35 +
                momentumScore * 0.20 +
                otherScore * 0.25
              );

              // 5) Pool memory adjustment
              const poolMem = getPoolScoreAdjustment(pool.address);
              if (poolMem.mem) {
                console.log(`  📚 Pool memory: ${poolMem.mem.deployCount}x deploy, WR ${poolMem.mem.winRate ?? "?"}%, avg ${poolMem.mem.avgPnlPct >= 0 ? "+" : ""}${poolMem.mem.avgPnlPct}%`);
              }
              if (poolMem.adjustment === -999) {
                console.log(`  📚 [PoolMem] SKIP: ${poolMem.reason}`);
                momentumSkip = true;
              } else if (poolMem.adjustment !== 0) {
                totalScore = Math.max(0, Math.min(100, totalScore + poolMem.adjustment));
                console.log(`  📚 [PoolMem] score ${poolMem.adjustment > 0 ? "+" : ""}${poolMem.adjustment} (${poolMem.reason})`);
              }

              console.log(`  [Score] ${pool.name}: fee=${feeScore} vol=${volScore} momentum=${momentumScore} other=${otherScore} → total=${totalScore}/100`);

              if (totalScore > 85) dynamicSol = 5;
              else if (totalScore >= 75) dynamicSol = 4;
              else if (totalScore >= 65) dynamicSol = 3;
              else if (totalScore >= 50) dynamicSol = 2;
              else if (totalScore >= 40) dynamicSol = 1;
              else { dynamicSol = 0; momentumSkip = true; console.log(`  [PositionSize] score=${totalScore} < 40 → SKIP`); }

              dynamicSol = Math.min(dynamicSol, config.maxSolPerPosition);
              console.log(`  [PositionSize] ${tokenSym ?? "?"} score=${totalScore} (organic=${organic} opp=${opportunity}) → ${dynamicSol} SOL`);
            } catch {}

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
                decision,
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
