import { config } from "../config.js";

const METEORA_API = "https://dlmm.datapi.meteora.ag";
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/pairs/solana";

const SKIP_TOKENS = [
  "USDC", "USDT", "BUSD", "DAI", "WSOL", "WBTC", "WETH", "CBBTC", "MSOL", "JITOSOL", "BSOL"
];

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

async function fetchPage(page, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${METEORA_API}/pools?page=${page}&limit=50`, {
        signal: controller.signal,
        headers: { "Accept": "application/json" }
      });
      clearTimeout(timeout);
      const text = await res.text();
      if (!text || text.trim() === "") continue;
      return JSON.parse(text)?.data ?? [];
    } catch (err) {
      console.log(`  ⚠️ Page ${page} error (${i}/${retries}): ${err.message}`);
      if (i < retries) await new Promise(r => setTimeout(r, 2000 * i));
    }
  }
  return [];
}

// GeekLad formula: cek uptrend dari multi-timeframe volume
async function enrichWithDexScreener(pools) {
  const addresses = pools.map(p => p.address).slice(0, 30).join(",");
  try {
    const res = await fetch(`${DEXSCREENER_API}/${addresses}`, {
      signal: AbortSignal.timeout(10000),
      headers: { "Accept": "application/json" }
    });
    const data = await res.json();
    const pairs = data?.pairs ?? [];
    const pairMap = new Map(pairs.map(p => [p.pairAddress?.toLowerCase(), p]));

    return pools.map(pool => {
      const pair = pairMap.get(pool.address?.toLowerCase());
      if (!pair) return { ...pool, uptrend: false, aprScore: 0 };

      const vol5m = pair.volume?.m5 ?? 0;
      const vol1h = pair.volume?.h1 ?? 0;
      const vol6h = pair.volume?.h6 ?? 0;
      const vol24h = pair.volume?.h24 ?? 0;

      // GeekLad: project 24h fees dari tiap interval
      const feePct = (pool.apr ?? 0);
      const proj5m = (vol5m * 288) * feePct;
      const proj1h = (vol1h * 24) * feePct;
      const proj6h = (vol6h * 4) * feePct;
      const proj24h = vol24h * feePct;

      // Uptrend = volume makin naik dari 24h ke 5m
      const uptrend = proj5m > proj1h && proj1h > proj6h;
      const aprScore = Math.min(proj5m, proj1h, proj6h, proj24h); // konservatif: ambil minimum

      console.log(`  📈 ${pool.name}: 5m=${vol5m.toFixed(0)} 1h=${vol1h.toFixed(0)} 6h=${vol6h.toFixed(0)} uptrend=${uptrend}`);

      return { ...pool, uptrend, aprScore, dexPair: pair };
    });
  } catch (err) {
    console.log(`  ⚠️ DexScreener enrich error: ${err.message}`);
    return pools.map(p => ({ ...p, uptrend: false, aprScore: 0 }));
  }
}

export async function scanPools() {
  console.log("🔍 Scanning pools...");
  try {
    const allPools = [];
    for (let page = 1; page <= 5; page++) {
      const pools = await fetchPage(page);
      if (pools.length === 0) break;
      allPools.push(...pools);
    }
    console.log(`  Raw pools: ${allPools.length}`);
    if (allPools.length === 0) return [];

    const preFiltered = allPools.filter(p => {
      const vol = p.volume?.["24h"] ?? 0;
      const tvl = p.tvl ?? 0;
      const apr = (p.apr ?? 0) * 100;
      if (vol < 50_000) return false;
      if (tvl < 5_000) return false;
      if (apr < 10) return false;
      if (isStablecoinOnly(p.name)) return false;
      const ageMin = getPoolAgeMinutes(p);
      if (ageMin !== null && ageMin < 5) return false;
      if (ageMin !== null && ageMin > 10080) return false;
      return true;
    });

    // Enrich dengan GeekLad multi-timeframe
    console.log(`  📊 Enriching ${preFiltered.length} pools dengan DexScreener...`);
    const enriched = await enrichWithDexScreener(preFiltered);

    // Sort: uptrend dulu, lalu by aprScore
    enriched.sort((a, b) => {
      if (a.uptrend && !b.uptrend) return -1;
      if (!a.uptrend && b.uptrend) return 1;
      return (b.aprScore ?? 0) - (a.aprScore ?? 0);
    });

    const filtered = enriched.filter(p => {
      const vol = p.volume?.["24h"] ?? 0;
      const tvl = p.tvl ?? 0;
      const ageMin = getPoolAgeMinutes(p);
      const ageStr = ageMin ? (ageMin < 60 ? `${ageMin.toFixed(0)}m` : `${(ageMin/60).toFixed(1)}j`) : "no age";
      console.log(`  ${p.uptrend ? "🚀" : "✅"} ${p.name}: ${ageStr} | vol $${(vol/1000).toFixed(0)}k | tvl $${(tvl/1000).toFixed(0)}k | uptrend=${p.uptrend}`);
      return true;
    });

    console.log(`✅ Found ${filtered.length} qualifying pools (${filtered.filter(p=>p.uptrend).length} uptrend)`);
    return filtered;
  } catch (err) {
    console.error("❌ Pool scan failed:", err.message);
    return [];
  }
}

export function formatPoolsForLLM(pools) {
  return pools.map((p) => ({
    address: p.address,
    name: p.name,
    volume24h: Math.round(p.volume?.["24h"] ?? 0),
    feeApr: ((p.apr ?? 0) * 100).toFixed(1),
    tvl: Math.round(p.tvl ?? 0),
    binStep: p.pool_config?.bin_step,
    ageMinutes: getPoolAgeMinutes(p)?.toFixed(0) ?? "unknown",
    uptrend: p.uptrend ?? false,
    aprScore: p.aprScore?.toFixed(2) ?? "0",
  }));
}
