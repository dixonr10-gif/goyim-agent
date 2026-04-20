import { config } from "../config.js";

const METEORA_API = "https://dlmm.datapi.meteora.ag";
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/pairs/solana";

const SKIP_TOKENS = [
  "USDC", "USDT", "BUSD", "DAI", "WSOL", "WBTC", "WETH", "CBBTC", "MSOL", "JITOSOL", "BSOL"
];

let _lastScanResults = [];
export function getLastCandidates() { return _lastScanResults; }

// Returns Daily Fee/TVL in percent. Prefers real pool.fees["24h"]; when
// missing, estimates from volume × bin_step fee rate and caps at 30% to
// avoid the old over-inflation bug (e.g. BULL binStep=200 → fake 200%+).
export function getEffectiveApr(pool) {
  const tvl = pool?.tvl ?? 0;
  if (tvl <= 0) return 0;
  const fees24h = pool?.fees?.["24h"] ?? 0;
  if (fees24h > 0) return (fees24h / tvl) * 100;

  const volume24h = pool?.volume?.["24h"] ?? 0;
  const feeRate = pool?.pool_config?.bin_step
    ? pool.pool_config.bin_step * 0.0001
    : 0.003;
  const estimatedFees = volume24h * feeRate;
  const fallbackApr = tvl > 0 ? (estimatedFees / tvl) * 100 : 0;
  return Math.min(fallbackApr, 30);
}

function calculateOrganicScore(pool, dexPair) {
  let score = 50;
  const vol24h = pool.volume?.["24h"] ?? 0;
  const tvl = pool.tvl ?? 1;
  const apr = getEffectiveApr(pool);
  const ageMin = getPoolAgeMinutes(pool) ?? 1440;

  // Volume/TVL ratio — high turnover = organic
  const volTvlRatio = vol24h / tvl;
  if (volTvlRatio > 5) score += 20;
  else if (volTvlRatio > 2) score += 10;
  else if (volTvlRatio < 0.5) score -= 20;

  if (dexPair) {
    const vol5m = dexPair.volume?.m5 ?? 0;
    const vol1h = dexPair.volume?.h1 ?? 0;
    const vol6h = dexPair.volume?.h6 ?? 0;

    // Spike detection: 5m projected way higher than 1h projected = wash/bot spike
    const proj5m = vol5m * 288;
    const proj1h = vol1h * 24;
    if (proj1h > 0 && proj5m > proj1h * 3) score -= 15;
    else if (proj1h > 0 && proj5m > proj1h * 1.5) score += 5;
    else score += 10;

    // Even distribution across timeframes = organic trading
    if (vol5m > 0 && vol1h > 0 && vol6h > 0) {
      const r1 = (vol5m * 12) / vol1h;
      const r2 = (vol1h * 6) / vol6h;
      if (r1 > 0.4 && r1 < 3 && r2 > 0.4 && r2 < 3) score += 10;
    }

    // Many small txns = organic retail, not whale wash
    const buys = dexPair.txns?.h24?.buys ?? 0;
    const sells = dexPair.txns?.h24?.sells ?? 0;
    const txns24h = buys + sells;
    const vol24h_dx = dexPair.volume?.h24 ?? vol24h;
    if (txns24h > 0 && vol24h_dx > 0) {
      const avgTxSize = vol24h_dx / txns24h;
      if (avgTxSize < 5000) score += 5;
    }
  }

  // High Daily Fee/TVL: only penalize extreme outliers, not normal meme pools
  if (apr > 14) score -= 10;
  else if (apr > 5.5) score -= 5;

  // High fee/TVL = real fees, not wash → bonus
  const feeRatio = vol24h / tvl;
  if (feeRatio >= 5) score += 10;

  // Sweet spot age: 30min to 2 days
  if (ageMin >= 30 && ageMin <= 2880) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function getPoolAgeMinutes(pool) {
  const createdAt = pool.created_at ?? pool.createdAt ?? pool.creation_time ?? null;
  if (!createdAt) return null;
  return (Date.now() - new Date(createdAt).getTime()) / 60_000;
}

function isStablecoinOnly(poolName) {
  if (!poolName) return false;
  const tokens = poolName.toUpperCase().split(/[-\/]/);
  return tokens.every(t => SKIP_TOKENS.includes(t.trim()));
}

// Fetch one pool's current stats (for post-entry monitoring by the healer's
// fee-APR-floor exit rule). Returns the raw pool object from the Meteora
// datapi, or null on any failure so callers can apply a permissive fallback.
// NOTE: the returned object uses the same shape as listings from
// fetchPage(), so getEffectiveApr(poolData) works on it unchanged.
export async function fetchPoolStats(address) {
  if (!address) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${METEORA_API}/pair/${address}`, {
      signal: controller.signal,
      headers: { "Accept": "application/json" }
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[fetchPoolStats] ${address.slice(0, 8)} HTTP ${res.status}`);
      return null;
    }
    const text = await res.text();
    if (!text || text.trim() === "") return null;
    const data = JSON.parse(text);
    // Meteora datapi wraps single-pool responses inconsistently — handle both
    // { data: {...} } and the bare pool object shapes.
    return data?.data ?? data ?? null;
  } catch (err) {
    console.warn(`[fetchPoolStats] ${address.slice(0, 8)} error: ${err.message}`);
    return null;
  }
}

async function fetchPage(page, sortKey = "fees", retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(`${METEORA_API}/pools?page=${page}&limit=50&sort_key=${sortKey}&order_by=desc`, {
        signal: controller.signal,
        headers: { "Accept": "application/json" }
      });
      clearTimeout(timeout);
      if (!res.ok) {
        console.log(`  ⚠️ Page ${page}/${sortKey} HTTP ${res.status} (${i}/${retries})`);
        if (i < retries) await new Promise(r => setTimeout(r, 2000 * i));
        continue;
      }
      const text = await res.text();
      if (!text || text.trim() === "") continue;
      return JSON.parse(text)?.data ?? [];
    } catch (err) {
      const isAbort = err.name === "AbortError" || err.message?.includes("aborted") || err.message?.includes("abort");
      console.log(`  ⚠️ Page ${page}/${sortKey} ${isAbort ? "timeout" : "error"} (${i}/${retries}): ${err.message}`);
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  return [];
}

// GeekLad formula: cek uptrend dari multi-timeframe volume
// Batch 30 at a time (DexScreener limit), enrich all pools
async function enrichWithDexScreener(pools) {
  const pairMap = new Map();
  const BATCH = 30;
  for (let i = 0; i < pools.length; i += BATCH) {
    const batch = pools.slice(i, i + BATCH);
    const addresses = batch.map(p => p.address).join(",");
    try {
      const res = await fetch(`${DEXSCREENER_API}/${addresses}`, {
        signal: AbortSignal.timeout(20000),
        headers: { "Accept": "application/json" }
      });
      const data = await res.json();
      for (const p of (data?.pairs ?? [])) {
        if (p.pairAddress) pairMap.set(p.pairAddress.toLowerCase(), p);
      }
      if (i + BATCH < pools.length) await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`  ⚠️ DexScreener batch ${i}-${i+BATCH} error: ${err.message}`);
    }
  }

  return pools.map(pool => {
    const pair = pairMap.get(pool.address?.toLowerCase());
    if (!pair) return { ...pool, uptrend: false, aprScore: 0, organicScore: calculateOrganicScore(pool, null) };

    const vol5m  = pair.volume?.m5  ?? 0;
    const vol1h  = pair.volume?.h1  ?? 0;
    const vol6h  = pair.volume?.h6  ?? 0;
    const vol24h = pair.volume?.h24 ?? 0;

    // GeekLad: project 24h fees dari tiap interval
    const feePct  = (pool.apr ?? 0);
    const proj5m  = (vol5m  * 288) * feePct;
    const proj1h  = (vol1h  *  24) * feePct;
    const proj6h  = (vol6h  *   4) * feePct;
    const proj24h =  vol24h         * feePct;

    // Uptrend = volume makin naik dari 24h ke 5m
    const uptrend  = proj5m > proj1h && proj1h > proj6h;
    const aprScore = Math.min(proj5m, proj1h, proj6h, proj24h);

    console.log(`  📈 ${pool.name}: 5m=${vol5m.toFixed(0)} 1h=${vol1h.toFixed(0)} 6h=${vol6h.toFixed(0)} uptrend=${uptrend}`);

    const organicScore = calculateOrganicScore(pool, pair);
    return { ...pool, uptrend, aprScore, organicScore, dexPair: pair };
  });
}

export async function scanPools() {
  console.log("🔍 Scanning pools...");
  try {
    // Scan 750 pools per sort key: 15 pages by volume + 15 pages by fees (50 per page, deduped)
    const allPools = [];
    const seen = new Set();
    for (const sortKey of ["volume", "fees"]) {
      for (let page = 1; page <= 15; page++) {
        const pools = await fetchPage(page, sortKey);
        if (pools.length === 0) break;
        for (const p of pools) {
          if (p.address && !seen.has(p.address)) {
            seen.add(p.address);
            allPools.push(p);
          }
        }
      }
    }
    console.log(`  Raw pools: ${allPools.length} (deduped)`);
    if (allPools.length === 0) return [];

    const preFiltered = allPools.filter(p => {
      const vol = p.volume?.["24h"] ?? 0;
      const tvl = p.tvl ?? 0;
      const apr = getEffectiveApr(p);
      if (vol < 50_000) return false;
      if (tvl < 5_000) return false;
      if (apr < 1) return false;
      if (isStablecoinOnly(p.name)) return false;
      const ageMin = getPoolAgeMinutes(p);
      if (ageMin !== null && ageMin < 5) return false;
      if (ageMin !== null && ageMin > 10080) return false;
      return true;
    });

    // Enrich dengan GeekLad multi-timeframe
    console.log(`  📊 Enriching ${preFiltered.length} pools dengan DexScreener...`);
    const enriched = await enrichWithDexScreener(preFiltered);

    // Sort by aprScore only — uptrend is a scoring bonus, not a hard requirement
    enriched.sort((a, b) => {
      // Give uptrend pools a small boost (+20% of aprScore) but don't block non-uptrend
      const scoreA = (a.aprScore ?? 0) * (a.uptrend ? 1.2 : 1.0);
      const scoreB = (b.aprScore ?? 0) * (b.uptrend ? 1.2 : 1.0);
      return scoreB - scoreA;
    });

    const filtered = enriched.filter(p => {
      const vol = p.volume?.["24h"] ?? 0;
      const tvl = p.tvl ?? 0;
      const ageMin = getPoolAgeMinutes(p);
      const ageStr = ageMin ? (ageMin < 60 ? `${ageMin.toFixed(0)}m` : `${(ageMin/60).toFixed(1)}j`) : "no age";
      const organic = p.organicScore ?? 50;

      // maxTvl filter: reject oversaturated pools
      if (tvl > config.maxTvlUsd) {
        console.log(`  🚫 ${p.name}: TVL $${(tvl/1000).toFixed(0)}k > max $${(config.maxTvlUsd/1000).toFixed(0)}k`);
        return false;
      }
      // organic score filter
      if (organic < config.minOrganicScore) {
        const feeRatio = tvl > 0 ? ((vol / tvl) * 100).toFixed(1) : "0";
        console.log(`  🚫 ${p.name}: organic=${organic} < min=${config.minOrganicScore}, fee/TVL=${feeRatio}%`);
        return false;
      }

      console.log(`  ${p.uptrend ? "🚀" : "✅"} ${p.name}: ${ageStr} | vol $${(vol/1000).toFixed(0)}k | tvl $${(tvl/1000).toFixed(0)}k | organic=${organic} | uptrend=${p.uptrend}`);
      return true;
    });

    _lastScanResults = filtered;
    console.log(`✅ Found ${filtered.length} qualifying pools (${filtered.filter(p=>p.uptrend).length} uptrend)`);
    return filtered;
  } catch (err) {
    console.error("❌ Pool scan failed:", err.message);
    return [];
  }
}

// Meteora fee_tvl_ratio trending — pools with highest fee efficiency (hot pools)
// Sorted by fee_tvl_ratio desc = most fees relative to TVL = trending
export async function fetchDexScreenerMeteora() {
  const candidates = [];
  try {
    for (let page = 1; page <= 4; page++) {
      const res = await fetch(`${METEORA_API}/pools?page=${page}&limit=50&sort_key=fee_tvl_ratio&order_by=desc`, {
        signal: AbortSignal.timeout(20000),
        headers: { "Accept": "application/json" }
      });
      if (!res.ok) break;
      const text = await res.text();
      if (!text || text.trim() === "") break;
      const pools = JSON.parse(text)?.data ?? [];
      if (pools.length === 0) break;

      for (const p of pools) {
        const vol = p.volume?.["24h"] ?? 0;
        const tvl = p.tvl ?? 0;
        if (vol < 50_000 || tvl < 5_000) continue;
        if (isStablecoinOnly(p.name)) continue;
        const ageMin = getPoolAgeMinutes(p);
        if (ageMin !== null && ageMin < 5) continue;
        if (ageMin !== null && ageMin > 10080) continue;
        candidates.push({
          ...p,
          dexMeteoraTrending: true,
        });
      }
    }
    console.log(`  📈 Meteora fee_tvl_ratio: ${candidates.length} candidates`);
  } catch (err) {
    console.warn(`  ⚠️ Meteora fee_tvl_ratio error: ${err.message}`);
  }
  return candidates;
}

export function formatPoolsForLLM(pools) {
  return pools.map((p) => ({
    address: p.address,
    name: p.name,
    volume24h: Math.round(p.volume?.["24h"] ?? 0),
    feeApr: getEffectiveApr(p).toFixed(1),
    tvl: Math.round(p.tvl ?? 0),
    binStep: p.pool_config?.bin_step,
    ageMinutes: getPoolAgeMinutes(p)?.toFixed(0) ?? "unknown",
    uptrend: p.uptrend ?? false,
    aprScore: p.aprScore?.toFixed(2) ?? "0",
    organicScore: p.organicScore ?? 50,
  }));
}
