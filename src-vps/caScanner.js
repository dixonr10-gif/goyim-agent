// src/caScanner.js — Contract Address scanner for Telegram inline use

const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex";
const METEORA_API = "https://dlmm.datapi.meteora.ag";
const BIRDEYE_API = "https://public-api.birdeye.so/defi";
const GECKO_API = "https://api.geckoterminal.com/api/v2/networks/solana";

const ALLOWED_LAUNCHPADS = (process.env.ALLOWED_LAUNCHPADS ?? "pump.fun,pumpswap,pump.swap,moonshot,met-dbc,raydium,launchlab")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// Normalize launchpad name for display
function displayLaunchpad(raw) {
  if (!raw) return "unknown";
  const l = raw.toLowerCase();
  if (l.includes("pump")) return "PumpFun";
  if (l.includes("moonshot")) return "Moonshot";
  if (l.includes("raydium")) return "Raydium";
  if (l.includes("met-dbc") || l.includes("meteora")) return "Meteora";
  if (l.includes("launchlab")) return "LaunchLab";
  return raw;
}

function isAllowedLaunchpad(raw) {
  if (!raw) return null; // unknown
  const l = raw.toLowerCase();
  return ALLOWED_LAUNCHPADS.some(a => l.includes(a));
}

// ─── Main scan function ──────────────────────────────────────────────

export async function scanCA(mintAddress) {
  console.log(`[CA] Scanning ${mintAddress.slice(0, 8)}...`);

  const result = {
    mint: mintAddress,
    token: null,
    pools: [],
    security: null,
    socials: [],
    score: 0,
    scoreBreakdown: [],
  };

  // ── 1. DexScreener token data ───────────────────────────────────
  let dexPairs = [];
  try {
    const res = await fetch(`${DEXSCREENER_API}/tokens/${mintAddress}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    dexPairs = Array.isArray(data?.pairs) ? data.pairs : [];
    dexPairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    if (dexPairs.length > 0) {
      const WSOL = "So11111111111111111111111111111111111111112";
      const pair = dexPairs.find(p => p.baseToken?.address === mintAddress) ?? dexPairs[0];
      const token = pair.baseToken?.address === mintAddress ? pair.baseToken : pair.quoteToken;

      const allCreatedAts = dexPairs.map(p => p.pairCreatedAt).filter(t => t > 0);
      const createdAt = allCreatedAts.length > 0 ? Math.min(...allCreatedAts) : null;

      // Detect launchpad from multiple sources
      const pairLabels = (pair.labels ?? []).map(l => l.toLowerCase());
      const pairInfo = pair.info ?? {};
      const websites = (pairInfo.websites ?? []).map(w => (w.url ?? w).toLowerCase());
      const rawLaunchpad = pairInfo.launchpad?.toLowerCase()
        ?? pairLabels.find(l => ALLOWED_LAUNCHPADS.some(a => l.includes(a)))
        ?? websites.find(w => ALLOWED_LAUNCHPADS.some(a => w.includes(a)))
        ?? pair.dexId?.toLowerCase()
        ?? null;

      // Extract socials
      const socials = [];
      for (const s of pairInfo.socials ?? []) {
        if (s.type === "twitter" || s.url?.includes("twitter") || s.url?.includes("x.com"))
          socials.push({ type: "twitter", url: s.url });
        else if (s.type === "telegram" || s.url?.includes("t.me"))
          socials.push({ type: "telegram", url: s.url });
      }
      for (const w of pairInfo.websites ?? []) {
        const url = w.url ?? w;
        if (!url.includes("twitter") && !url.includes("t.me") && !url.includes("x.com"))
          socials.push({ type: "website", url });
      }
      result.socials = socials;

      result.token = {
        name: token?.name ?? "?",
        symbol: token?.symbol ?? "?",
        price: parseFloat(pair.priceUsd ?? "0"),
        mcap: pair.marketCap ?? pair.fdv ?? 0,
        volume24h: pair.volume?.h24 ?? 0,
        liquidity: pair.liquidity?.usd ?? 0,
        priceChange24h: pair.priceChange?.h24 ?? 0,
        txns24h: (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0),
        createdAt,
        ageMs: createdAt ? Date.now() - createdAt : null,
        launchpad: rawLaunchpad,
        launchpadAllowed: isAllowedLaunchpad(rawLaunchpad),
        hasTwitter: socials.some(s => s.type === "twitter"),
        pairAddress: pair.pairAddress,
      };
    }
  } catch (e) { console.warn("[CA] DexScreener error:", e.message); }

  // ── 2. Meteora pools — all 3 layers run, deduplicate, sort by TVL ──
  const poolMap = new Map();

  // Layer 1: DexScreener /tokens pairs filtered by meteora
  for (const p of dexPairs) {
    if (p.dexId?.toLowerCase().includes("meteora") && p.pairAddress) {
      poolMap.set(p.pairAddress, {
        address: p.pairAddress,
        name: `${p.baseToken?.symbol ?? "?"}/${p.quoteToken?.symbol ?? "?"}`,
        tvl: p.liquidity?.usd ?? 0,
        volume24h: p.volume?.h24 ?? 0,
        apr: null, feePct: null, binStep: null, source: "dexscreener",
      });
    }
  }

  // Layer 2: DexScreener /search (always run — catches pools /tokens misses)
  if (result.token?.symbol) {
    try {
      const sRes = await fetch(`${DEXSCREENER_API}/search?q=${encodeURIComponent(result.token.symbol + " SOL")}`, {
        signal: AbortSignal.timeout(10000),
      });
      const sData = await sRes.json();
      for (const p of (sData?.pairs ?? [])) {
        if (p.chainId === "solana" && p.dexId?.toLowerCase().includes("meteora") && p.pairAddress && !poolMap.has(p.pairAddress)) {
          poolMap.set(p.pairAddress, {
            address: p.pairAddress,
            name: `${p.baseToken?.symbol ?? "?"}/${p.quoteToken?.symbol ?? "?"}`,
            tvl: p.liquidity?.usd ?? 0,
            volume24h: p.volume?.h24 ?? 0,
            apr: null, feePct: null, binStep: null, source: "dexscreener-search",
          });
        }
      }
    } catch (e) { console.warn("[CA] DexScreener search error:", e.message); }
  }

  // Layer 3: GeckoTerminal (always run)
  try {
    const gRes = await fetch(`${GECKO_API}/tokens/${mintAddress}/pools?page=1`, {
      signal: AbortSignal.timeout(10000),
    });
    const gData = await gRes.json();
    for (const item of (gData?.data ?? [])) {
      const dexId = item.relationships?.dex?.data?.id ?? "";
      if (dexId.includes("meteora")) {
        const addr = item.attributes?.address;
        if (addr && !poolMap.has(addr)) {
          poolMap.set(addr, {
            address: addr,
            name: item.attributes?.name ?? "?",
            tvl: parseFloat(item.attributes?.reserve_in_usd ?? "0"),
            volume24h: parseFloat(item.attributes?.volume_usd?.h24 ?? "0"),
            apr: null, feePct: null, binStep: null, source: "geckoterminal",
          });
        }
      }
    }
  } catch (e) { console.warn("[CA] GeckoTerminal error:", e.message); }

  // Sort by TVL desc, enrich top 5 with Meteora datapi or DexScreener detail
  const allPools = [...poolMap.values()].sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  for (const pool of allPools.slice(0, 5)) {
    // Meteora datapi for APR/fee/binStep
    try {
      const dRes = await fetch(`${METEORA_API}/pair/${pool.address}`, { signal: AbortSignal.timeout(8000) });
      if (dRes.ok) {
        const pd = await dRes.json();
        // Meteora "apr" = fee_tvl_ratio (daily). Annualize: * 365
        const rawApr = pd.apr ?? pd.fee_tvl_ratio?.["24h"] ?? 0;
        pool.apr = (rawApr * 365 * 100).toFixed(1);
        pool.tvl = pd.tvl ?? pool.tvl;
        pool.feePct = pd.pool_config?.base_fee_pct ?? 0;
        pool.binStep = pd.pool_config?.bin_step;
        pool.volume24h = pd.volume?.["24h"] ?? pool.volume24h;
        pool.source = "meteora-enriched";
        continue;
      }
    } catch {}
    // DexScreener pair fallback
    try {
      const pRes = await fetch(`${DEXSCREENER_API}/pairs/solana/${pool.address}`, { signal: AbortSignal.timeout(8000) });
      const pData = await pRes.json();
      const pair = pData?.pair ?? pData?.pairs?.[0];
      if (pair) {
        pool.tvl = pair.liquidity?.usd ?? pool.tvl;
        pool.volume24h = pair.volume?.h24 ?? pool.volume24h;
        pool.name = `${pair.baseToken?.symbol ?? "?"}/${pair.quoteToken?.symbol ?? "?"}`;
        // Estimate APR from volume and fee rate
        if (pool.tvl > 0 && pool.volume24h > 0) {
          const feeRate = pool.feePct ?? 0.25; // default 0.25% fee
          pool.apr = (pool.volume24h / pool.tvl * (feeRate / 100) * 365 * 100).toFixed(1);
        }
        pool.source = "dexscreener-pair";
      }
    } catch {}
  }

  // ── DLMM validation — reject non-DLMM pools ─────────────────────
  const DLMM_VALIDATE = "https://dlmm-api.meteora.ag";
  await Promise.all(allPools.map(async (pool) => {
    if (pool.source === "meteora-enriched") { pool.isDlmm = true; return; }
    try {
      const vRes = await fetch(`${DLMM_VALIDATE}/pair/${pool.address}`, { signal: AbortSignal.timeout(5000) });
      pool.isDlmm = vRes.ok;
    } catch { pool.isDlmm = false; }
  }));

  // Mark low-liquidity pools
  for (const p of allPools) { p.lowLiquidity = (p.tvl ?? 0) < 1000; }

  const dlmmPools = allPools.filter(p => p.isDlmm).sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  result.pools = dlmmPools.slice(0, 3);
  result.nonDlmmCount = allPools.length - dlmmPools.length;
  console.log(`[CA] Found ${allPools.length} Meteora pool(s), ${dlmmPools.length} DLMM verified, top TVL: $${dlmmPools[0]?.tvl?.toFixed(0) ?? 0}`);

  // ── 3. Security — Birdeye primary, DexScreener fallback ─────────
  try {
    const res = await fetch(`${BIRDEYE_API}/token_security?address=${mintAddress}`, {
      headers: { "X-Chain": "solana" },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const sec = data?.data;
    if (sec) {
      const top10 = sec.top10HolderPercent ?? 0;
      result.security = {
        top10Pct: top10 > 1 ? top10 : top10 * 100,
        mintAuthority: sec.mintAuthority !== null,
        freezeAuthority: sec.freezeAuthority !== null,
        creatorPct: (() => { const v = sec.creatorPercentage ?? sec.ownerPercentage ?? 0; return v > 1 ? v : v * 100; })(),
      };
    }
  } catch (e) { console.warn("[CA] Birdeye error:", e.message); }

  // ── 4. Score ────────────────────────────────────────────────────
  const t = result.token;
  const s = result.security;
  let score = 0;
  const bd = [];

  if (t) {
    if (t.volume24h >= 100_000 && t.volume24h <= 50_000_000) { score += 20; bd.push("Vol ✅ +20"); }
    else if (t.volume24h > 50_000_000) { score -= 10; bd.push("Vol high -10"); }

    if (t.liquidity >= 15_000 && t.liquidity <= 1_000_000) { score += 15; bd.push("Liq ✅ +15"); }

    if (t.ageMs) {
      const ageH = t.ageMs / 3_600_000;
      if (ageH >= 12 && ageH <= 720) { score += 15; bd.push("Age ✅ +15"); }
      else if (ageH < 12) { score -= 15; bd.push("New -15"); }
    }

    if (t.launchpadAllowed === true) { score += 15; bd.push("LP ✅ +15"); }
    else if (t.launchpadAllowed === false) { score -= 10; bd.push("LP ⚠️ -10"); }

    if (t.txns24h > 1000) { score += 20; bd.push("Txns ✅ +20"); }
    else if (t.txns24h > 200) { score += 10; bd.push("Txns +10"); }
  }

  if (s) {
    if (s.top10Pct <= 60) { score += 15; bd.push("Dist ✅ +15"); }
    else { score -= 20; bd.push("Conc -20"); }
  }

  result.score = Math.max(0, Math.min(100, score));
  result.scoreBreakdown = bd;
  return result;
}

// ─── Format for Telegram ─────────────────────────────────────────────

export function formatCAScanMessage(scan) {
  const t = scan.token;
  const s = scan.security;

  if (!t) {
    return `🔍 <b>CA Scan</b>\n\n❌ Token <code>${scan.mint}</code> not found.`;
  }

  const solscanUrl = `https://solscan.io/token/${scan.mint}`;
  const ageStr = t.ageMs ? formatAge(t.ageMs) : "?";
  const lpName = displayLaunchpad(t.launchpad);
  const lpIcon = t.launchpadAllowed === true ? "✅" : t.launchpadAllowed === false ? "⚠️" : "❓";

  let msg = `🔍 <b>CA Scan Result</b>\n━━━━━━━━━━━━━━━\n`;
  msg += `🪙 <a href="${solscanUrl}"><b>${t.name}</b></a> (<code>${t.symbol}</code>)\n`;
  msg += `📋 CA: <code>${scan.mint}</code>\n\n`;

  msg += `📊 <b>Market Info:</b>\n`;
  msg += `💵 Price: <b>$${formatPrice(t.price)}</b> | 24h: <b>${t.priceChange24h >= 0 ? "+" : ""}${t.priceChange24h?.toFixed(1) ?? "?"}%</b>\n`;
  msg += `📈 MCap: <b>$${fmtNum(t.mcap)}</b> | Vol: <b>$${fmtNum(t.volume24h)}</b>\n`;
  msg += `💧 Liq: <b>$${fmtNum(t.liquidity)}</b> | Txns: <b>${t.txns24h.toLocaleString()}</b>\n`;
  msg += `⏱️ Age: <b>${ageStr}</b> | 🚀 ${lpName} ${lpIcon}\n`;

  // Socials
  if (scan.socials.length > 0) {
    const links = [];
    for (const s of scan.socials) {
      if (s.type === "twitter") links.push(`🐦 <a href="${s.url}">Twitter</a>`);
      else if (s.type === "telegram") links.push(`💬 <a href="${s.url}">Telegram</a>`);
      else if (s.type === "website") links.push(`🌐 <a href="${s.url}">Web</a>`);
    }
    if (links.length) msg += links.join(" | ") + "\n";
  }
  msg += "\n";

  // Meteora pools
  if (scan.pools.length > 0) {
    msg += `🏊 <b>Meteora Pools:</b>\n`;
    for (const p of scan.pools.slice(0, 3)) {
      const url = `https://app.meteora.ag/dlmm/${p.address}`;
      const apr = p.apr ?? "?";
      const warn = p.lowLiquidity ? " ⚠️" : "";
      msg += `• <a href="${url}">${p.name}</a> | APR: ${apr}% | TVL: $${fmtNum(p.tvl)}${warn} | Vol: $${fmtNum(p.volume24h)}\n`;
    }
    if (scan.pools.every(p => p.lowLiquidity)) msg += `<i>⚠️ All pools have low liquidity (&lt;$1K)</i>\n`;
    msg += "\n";
  } else {
    const searchUrl = `https://app.meteora.ag/pools?search=${encodeURIComponent(t.symbol)}`;
    const filtered = scan.nonDlmmCount ? ` (${scan.nonDlmmCount} non-DLMM filtered)` : "";
    msg += `🏊 <i>No DLMM pools found${filtered}</i> — <a href="${searchUrl}">Search ↗</a>\n\n`;
  }

  // Security
  msg += `🔒 <b>Security:</b>\n`;
  if (s) {
    msg += `👥 Top 10: <b>${s.top10Pct.toFixed(0)}%</b> ${s.top10Pct <= 60 ? "✅" : "⚠️"}`;
    msg += ` | 🔑 Mint: ${s.mintAuthority ? "⚠️ On" : "✅ Off"}`;
    if (s.freezeAuthority) msg += ` | ❄️ Freeze: ⚠️`;
    msg += "\n";
  } else {
    msg += `<i>Security data unavailable</i>\n`;
  }

  // Score
  const emoji = scan.score >= 70 ? "🟢" : scan.score >= 40 ? "🟡" : "🔴";
  const filled = Math.round(scan.score / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  msg += `\n🎯 <b>Score: ${emoji} ${scan.score}/100</b>\n`;
  msg += `[${bar}]\n`;
  msg += `<i>${scan.scoreBreakdown.join(" | ")}</i>`;

  return msg;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatAge(ms) {
  const h = Math.floor(ms / 3_600_000);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatPrice(p) {
  if (p >= 1) return p.toFixed(2);
  if (p >= 0.01) return p.toFixed(4);
  if (p >= 0.0001) return p.toFixed(6);
  return p.toExponential(2);
}

function fmtNum(n) {
  if (!n || n === 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n.toFixed(0);
}
