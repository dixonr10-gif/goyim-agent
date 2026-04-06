const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";
const BIRDEYE_API = "https://public-api.birdeye.so/defi";

const WSOL = "So11111111111111111111111111111111111111112";

// Wrapped tokens — always reject (low volatility / not meme)
const WRAPPED_TOKEN_SYMS = new Set([
  "WBTC","WETH","WSOL","WBNB","WAVAX","WMATIC","CBBTC","TBTC","HBTC","BTCB",
]);

// Known stablecoins and major tokens — skip viability check, auto-approve
const KNOWN_SAFE_TOKENS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX",  // USDH
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // ETH (wormhole)
]);

// Allowed launchpads (from .env or defaults)
function getAllowedLaunchpads() {
  return (process.env.ALLOWED_LAUNCHPADS ?? "pump.fun,pumpswap,pumpfun,pump_fun,pump.swap,moonshot,met-dbc,meteora,raydium,launchlab")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function isLaunchpadAllowed(detected, allowedList) {
  const d = detected.toLowerCase();
  return allowedList.some(a => d.includes(a) || a.includes(d));
}

async function getBirdeyeData(tokenMint) {
  try {
    const [overview, security] = await Promise.all([
      fetch(`${BIRDEYE_API}/token_overview?address=${tokenMint}`, {
        headers: { "X-Chain": "solana" },
        signal: AbortSignal.timeout(8000),
      }).then(r => r.json()),
      fetch(`${BIRDEYE_API}/token_security?address=${tokenMint}`, {
        headers: { "X-Chain": "solana" },
        signal: AbortSignal.timeout(8000),
      }).then(r => r.json()),
    ]);
    return { overview: overview?.data, security: security?.data };
  } catch (err) {
    console.log(`  ⚠️ Birdeye error: ${err.message}`);
    return { overview: null, security: null };
  }
}

export async function checkTokenViability(poolAddress, tokenMint) {
  console.log(`🔍 Checking token: ${tokenMint?.slice(0,8)}...`);

  // Known stablecoins / major tokens — always safe, skip checks
  if (KNOWN_SAFE_TOKENS.has(tokenMint)) {
    console.log(`  ✅ Known safe token — auto-approved`);
    return { viable: true, score: 90, reasons: ["Known stablecoin/major token"], warnings: [] };
  }

  const result = {
    viable: false,
    score: 0,
    reasons: [],
    warnings: [],
  };

  // ─── DexScreener ────────────────────────────────────────────
  let dexPairs = [];
  try {
    const res = await fetch(`${DEXSCREENER_API}/${tokenMint}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    dexPairs = data?.pairs ?? [];

    if (dexPairs.length === 0) {
      result.warnings.push("Token tidak ditemukan di DexScreener");
      result.score -= 20;
    } else {
      const pair =
        dexPairs.find(p => p.baseToken?.address === tokenMint) ??
        dexPairs.find(p => p.baseToken?.address !== WSOL) ??
        dexPairs[0];

      const tokenSymbol = pair.baseToken?.address === tokenMint
        ? (pair.baseToken?.symbol ?? tokenMint.slice(0, 8))
        : (pair.quoteToken?.symbol ?? tokenMint.slice(0, 8));

      const symUpper = tokenSymbol.toUpperCase();

      // Reject wrapped tokens
      if (WRAPPED_TOKEN_SYMS.has(symUpper)) {
        console.log(`  ⛔ ${tokenSymbol}: wrapped token — reject`);
        result.warnings.push(`Wrapped token ${tokenSymbol} — bukan meme`);
        result.viable = false;
        return result;
      }

      // Reject LP tokens
      if (symUpper.includes("LP") || symUpper.endsWith("-LP")) {
        console.log(`  ⛔ ${tokenSymbol}: LP token — reject`);
        result.warnings.push(`LP token ${tokenSymbol} — bukan meme`);
        result.viable = false;
        return result;
      }

      // ─── Launchpad filter ──────────────────────────────────────
      const checkLaunchpad = process.env.CHECK_LAUNCHPAD !== "false";
      if (checkLaunchpad) {
        const allowed = getAllowedLaunchpads();
        // DexScreener stores launchpad info in pair.info or pair.labels
        const pairLabels = (pair.labels ?? []).map(l => l.toLowerCase());
        const pairInfo = pair.info ?? {};
        const launchpad = pairInfo.launchpad?.toLowerCase()
          ?? pairLabels.find(l => allowed.some(a => l.includes(a)))
          ?? null;
        // Also check the "profile" field and websites
        const websites = (pairInfo.websites ?? []).map(w => (w.url ?? w).toLowerCase());
        const detectedLaunchpad = launchpad
          ?? websites.find(w => allowed.some(a => w.includes(a)))
          ?? (pair.dexId?.toLowerCase())
          ?? null;

        if (detectedLaunchpad) {
          const lpAllowed = isLaunchpadAllowed(detectedLaunchpad, allowed);
          console.log(`  [Launchpad] detected: ${detectedLaunchpad} → ${lpAllowed ? "allowed" : "blocked"}`);
          if (!lpAllowed) {
            result.warnings.push(`Launchpad not allowed: ${detectedLaunchpad}`);
            result.viable = false;
            return result;
          }
        }
        // If no launchpad info found → allow (don't block on missing data)
      }

      // ─── Hard-reject thresholds (from .env) ───────────────────
      const MIN_AGE_MS  = (parseFloat(process.env.MIN_TOKEN_AGE_HOURS) || 1) * 3_600_000;
      const MIN_VOL     = parseFloat(process.env.MIN_VOLUME_24H)   || 100_000;
      const MIN_LIQ     = parseFloat(process.env.MIN_LIQUIDITY_USD) || 15_000;
      const MAX_LIQ     = parseFloat(process.env.MAX_LIQUIDITY_USD) || 1_000_000;

      // Token age — only enforce minimum
      const allCreatedAts = dexPairs.map(p => p.pairCreatedAt).filter(t => t > 0);
      const tokenCreatedAt = allCreatedAts.length > 0 ? Math.min(...allCreatedAts) : null;
      if (tokenCreatedAt) {
        const ageMs = Date.now() - tokenCreatedAt;
        if (ageMs < MIN_AGE_MS) {
          const ageMin = Math.floor(ageMs / 60_000);
          console.log(`  ⛔ ${tokenSymbol}: too new (${ageMin}m old)`);
          result.warnings.push(`Too new (${ageMin}m old)`);
          result.viable = false;
          return result;
        }
        console.log(`  ⏰ Token age: ${(ageMs / 3_600_000).toFixed(1)}h`);
      }

      // Volume + wash trading detection via Vol/TVL ratio
      const vol24h = pair.volume?.h24 ?? 0;
      const liqForRatio = pair.liquidity?.usd ?? 1;
      const volTvlRatio = vol24h / liqForRatio;

      if (vol24h < MIN_VOL || volTvlRatio < 0.5) {
        console.log(`  ⛔ ${tokenSymbol}: volume too low ($${(vol24h/1000).toFixed(0)}k, vol/tvl=${volTvlRatio.toFixed(1)}x)`);
        result.warnings.push(`Vol too low $${(vol24h/1000).toFixed(0)}k`);
        result.viable = false;
        return result;
      }
      const txns24h = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
      if (volTvlRatio > 100 && txns24h < 20000) {
        console.log(`  [WashTrading] ${tokenSymbol} vol/tvl=${volTvlRatio.toFixed(0)}x | txns=${txns24h} → block`);
        result.warnings.push(`Wash trading suspected: vol/tvl=${volTvlRatio.toFixed(0)}x`);
        result.viable = false;
        return result;
      }
      if (volTvlRatio > 100) {
        console.log(`  [WashTrading] ${tokenSymbol} vol/tvl=${volTvlRatio.toFixed(0)}x | txns=${txns24h} → pass (high txn count)`);
      }

      // Liquidity hard reject
      const liq = pair.liquidity?.usd ?? 0;
      if (liq < MIN_LIQ) {
        console.log(`  ⛔ ${tokenSymbol}: liquidity too low ($${(liq/1000).toFixed(0)}k)`);
        result.warnings.push(`Liq too low $${(liq/1000).toFixed(0)}k`);
        result.viable = false;
        return result;
      }
      if (liq > MAX_LIQ) {
        console.log(`  ⛔ ${tokenSymbol}: liquidity too high ($${(liq/1_000_000).toFixed(1)}M)`);
        result.warnings.push(`Liq too high $${(liq/1_000_000).toFixed(1)}M`);
        result.viable = false;
        return result;
      }

      // Price change filter — skip dump -70% atau lebih
      const priceChangeRaw = pair.priceChange?.h24 ?? 0;
      if (priceChangeRaw <= -70) {
        console.log(`  🚨 Dump ${priceChangeRaw.toFixed(0)}% — DITOLAK`);
        result.warnings.push(`Token dump ${priceChangeRaw.toFixed(0)}% — SKIP!`);
        result.viable = false;
        return result;
      }

      // Volume scoring
      if (vol24h > 5_000_000) { result.score += 25; result.reasons.push(`Vol $${(vol24h/1_000_000).toFixed(1)}M`); }
      else if (vol24h > 500_000) { result.score += 20; result.reasons.push(`Vol $${(vol24h/1000).toFixed(0)}k`); }
      else { result.score += 10; result.reasons.push(`Vol $${(vol24h/1000).toFixed(0)}k`); }

      const priceChange = Math.abs(priceChangeRaw);
      if (priceChange > 50) { result.score += 20; result.reasons.push(`Volatile ${priceChange.toFixed(0)}%`); }
      else if (priceChange > 20) { result.score += 10; result.reasons.push(`Moving ${priceChange.toFixed(0)}%`); }

      // Liquidity scoring
      if (liq > 200_000) { result.score += 15; result.reasons.push(`Liq $${(liq/1000).toFixed(0)}k`); }
      else if (liq > 50_000) { result.score += 10; result.reasons.push(`Liq $${(liq/1000).toFixed(0)}k`); }
      else { result.score += 5; }

      const txns = (pair.txns?.h24?.buys ?? 0) + (pair.txns?.h24?.sells ?? 0);
      if (txns > 1000) { result.score += 20; result.reasons.push(`Aktif ${txns} txns`); }
      else if (txns > 200) { result.score += 10; result.reasons.push(`${txns} txns`); }
      else { result.score -= 10; result.warnings.push(`Sepi ${txns} txns`); }

      const socials = pair.info?.socials ?? [];
      const hasTwitter = socials.some(s => s.type === "twitter" || s.url?.includes("twitter") || s.url?.includes("x.com"));
      if (hasTwitter) { result.score += 15; result.reasons.push("Ada Twitter/X"); }
      else { result.score -= 15; result.warnings.push("Tidak ada Twitter/X"); }

      // ─── Market cap filter (from .env) ─────────────────────────
      const MIN_MCAP = parseFloat(process.env.MIN_MARKET_CAP_USD) || 100_000;
      const MAX_MCAP = parseFloat(process.env.MAX_MARKET_CAP_USD) || 30_000_000;
      const mcap = pair.marketCap ?? pair.fdv ?? 0;
      if (mcap > 0) {
        if (mcap > MAX_MCAP) {
          console.log(`  ⛔ ${tokenSymbol}: mcap $${(mcap/1_000_000).toFixed(1)}M > max $${(MAX_MCAP/1_000_000).toFixed(0)}M — reject`);
          result.warnings.push(`Large cap $${(mcap/1_000_000).toFixed(1)}M > max $${(MAX_MCAP/1_000_000).toFixed(0)}M`);
          result.viable = false;
          return result;
        } else if (mcap < MIN_MCAP) {
          result.score -= 20;
          result.warnings.push(`Micro cap $${(mcap/1000).toFixed(0)}k < min $${(MIN_MCAP/1000).toFixed(0)}k — rug risk`);
        } else if (mcap < 10_000_000) {
          result.score += 15;
          result.reasons.push(`Small cap $${(mcap/1000).toFixed(0)}k`);
        } else {
          result.score += 5;
          result.reasons.push(`Mid cap $${(mcap/1_000_000).toFixed(1)}M`);
        }
        console.log(`  💰 Market cap: $${(mcap/1_000_000).toFixed(1)}M (range: $${(MIN_MCAP/1000).toFixed(0)}k–$${(MAX_MCAP/1_000_000).toFixed(0)}M)`);
      }

      console.log(`  📊 DexScreener: vol=$${(vol24h/1000).toFixed(0)}k | liq=$${(liq/1000).toFixed(0)}k | txns=${txns} | twitter=${hasTwitter} | age=${tokenCreatedAt ? ((Date.now()-tokenCreatedAt)/3_600_000).toFixed(1)+"h" : "?"}`);
    }
  } catch (err) {
    console.error(`  ❌ DexScreener error: ${err.message}`);
    result.score -= 10;
  }

  // ─── Birdeye ────────────────────────────────────────────────
  const { overview, security } = await getBirdeyeData(tokenMint);

  if (overview) {
    const holders = overview.holder ?? 0;
    const uniqueWallets24h = overview.uniqueWallet24h ?? 0;

    if (holders > 1000) { result.score += 20; result.reasons.push(`${holders} holders`); }
    else if (holders > 300) { result.score += 10; result.reasons.push(`${holders} holders`); }
    else { result.score -= 10; result.warnings.push(`Sedikit holder (${holders})`); }

    if (uniqueWallets24h > 500) { result.score += 15; result.reasons.push(`${uniqueWallets24h} wallet aktif`); }
    else if (uniqueWallets24h > 100) { result.score += 5; }

    const buy24h = overview.buy24h ?? 0;
    const sell24h = overview.sell24h ?? 0;
    if (buy24h > sell24h * 1.2) { result.score += 10; result.reasons.push(`Buy pressure (${buy24h}B/${sell24h}S)`); }
    else if (sell24h > buy24h * 1.5) { result.score -= 15; result.warnings.push(`Sell pressure tinggi`); }

    console.log(`  🦅 Birdeye: holders=${holders} | wallets24h=${uniqueWallets24h} | buy/sell=${buy24h}/${sell24h}`);
  }

  // ─── Supply concentration (Birdeye security) ────────────────
  const MAX_TOP10_PCT = parseFloat(process.env.MAX_TOP10_HOLDERS_PCT) || 60;
  const MAX_DEV_PCT   = parseFloat(process.env.MAX_DEV_WALLET_PCT) || 20;

  if (security) {
    const topHolderPct = security.top10HolderPercent ?? 0;
    const topPctDisplay = topHolderPct > 1 ? topHolderPct : topHolderPct * 100;

    // Hard reject: top 10 holders > MAX_TOP10_PCT
    if (topPctDisplay > MAX_TOP10_PCT) {
      console.log(`  ⛔ Top 10 holders ${topPctDisplay.toFixed(0)}% > ${MAX_TOP10_PCT}% — high concentration`);
      result.warnings.push(`Top 10 holders ${topPctDisplay.toFixed(0)}% — rug risk!`);
      result.viable = false;
      return result;
    } else if (topPctDisplay > 50) {
      result.score -= 10;
      result.warnings.push(`Concentrated ${topPctDisplay.toFixed(0)}%`);
    } else {
      result.score += 10;
      result.reasons.push(`Distributed holders`);
    }

    // Dev wallet check
    const creatorPct = (security.creatorPercentage ?? security.ownerPercentage ?? 0);
    const devPctDisplay = creatorPct > 1 ? creatorPct : creatorPct * 100;
    if (devPctDisplay > MAX_DEV_PCT) {
      console.log(`  ⛔ Dev wallet ${devPctDisplay.toFixed(0)}% > ${MAX_DEV_PCT}% — rug risk`);
      result.warnings.push(`Dev wallet ${devPctDisplay.toFixed(0)}% — rug risk!`);
      result.viable = false;
      return result;
    }

    const mintable = security.mintAuthority !== null;
    const freezable = security.freezeAuthority !== null;
    if (mintable) { result.score -= 15; result.warnings.push("Mint authority aktif — rug risk!"); }
    if (freezable) { result.score -= 10; result.warnings.push("Freeze authority aktif"); }

    console.log(`  🔒 Security: top10=${topPctDisplay.toFixed(0)}% | dev=${devPctDisplay.toFixed(0)}% | mintable=${mintable} | freezable=${freezable}`);
  }

  const hasRugWarning = result.warnings.some(w => w.includes("rug") || w.includes("Mint authority"));
  result.viable = result.score >= 30 && !hasRugWarning;

  console.log(`  ${result.viable ? "✅" : "❌"} Score=${result.score} | viable=${result.viable}`);
  if (result.reasons.length) console.log(`  ✅ ${result.reasons.join(", ")}`);
  if (result.warnings.length) console.log(`  ⚠️ ${result.warnings.join(", ")}`);

  return result;
}
