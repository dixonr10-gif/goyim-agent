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
  try {
    const res = await fetch(`${DEXSCREENER_API}/${tokenMint}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const pairs = data?.pairs ?? [];

    if (pairs.length === 0) {
      result.warnings.push("Token tidak ditemukan di DexScreener");
      result.score -= 20;
    } else {
      // Find the pair where our alt token is the BASE token (not SOL as base)
      // DexScreener may return pairs where SOL is base — we want our token as base
      const pair =
        pairs.find(p => p.baseToken?.address === tokenMint) ??
        pairs.find(p => p.baseToken?.address !== WSOL) ??
        pairs[0];

      const tokenSymbol = pair.baseToken?.address === tokenMint
        ? (pair.baseToken?.symbol ?? tokenMint.slice(0, 8))
        : (pair.quoteToken?.symbol ?? tokenMint.slice(0, 8));

      const symUpper = tokenSymbol.toUpperCase();

      // Reject wrapped tokens (WBTC, WETH, cbBTC, etc.) — low volatility, not meme
      if (WRAPPED_TOKEN_SYMS.has(symUpper)) {
        console.log(`  ⛔ ${tokenSymbol}: wrapped token — reject`);
        result.warnings.push(`Wrapped token ${tokenSymbol} — bukan meme`);
        result.viable = false;
        return result;
      }

      // Reject LP tokens (JLP, raydium LP, etc.) — complex instruments, not meme
      if (symUpper.includes("LP") || symUpper.endsWith("-LP")) {
        console.log(`  ⛔ ${tokenSymbol}: LP token — reject`);
        result.warnings.push(`LP token ${tokenSymbol} — bukan meme`);
        result.viable = false;
        return result;
      }

      // ─── Hard-reject thresholds (from .env) ───────────────────
      const MIN_AGE_MS  = (parseFloat(process.env.MIN_TOKEN_AGE_HOURS) || 1)          * 3_600_000;
      const MAX_AGE_MS  = (parseFloat(process.env.MAX_TOKEN_AGE_DAYS)  || 30)         * 86_400_000;
      const MIN_VOL     = parseFloat(process.env.MIN_VOLUME_24H)   || 100_000;
      const MAX_VOL     = parseFloat(process.env.MAX_VOLUME_24H)   || 15_000_000;
      const MIN_LIQ     = parseFloat(process.env.MIN_LIQUIDITY_USD) || 15_000;
      const MAX_LIQ     = parseFloat(process.env.MAX_LIQUIDITY_USD) || 1_000_000;

      // Token age — check earliest pairCreatedAt across all pairs for this token
      const allCreatedAts = pairs.map(p => p.pairCreatedAt).filter(t => t > 0);
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
        if (ageMs > MAX_AGE_MS) {
          const ageDays = Math.floor(ageMs / 86_400_000);
          console.log(`  ⛔ ${tokenSymbol}: too old (${ageDays}d old)`);
          result.warnings.push(`Too old (${ageDays}d old)`);
          result.viable = false;
          return result;
        }
        console.log(`  ⏰ Token age: ${(ageMs / 3_600_000).toFixed(1)}h`);
      }

      // Volume hard reject
      const vol24h = pair.volume?.h24 ?? 0;
      if (vol24h < MIN_VOL) {
        console.log(`  ⛔ ${tokenSymbol}: volume too low ($${(vol24h/1000).toFixed(0)}k)`);
        result.warnings.push(`Vol too low $${(vol24h/1000).toFixed(0)}k`);
        result.viable = false;
        return result;
      }
      if (vol24h > MAX_VOL) {
        console.log(`  ⛔ ${tokenSymbol}: volume too high ($${(vol24h/1_000_000).toFixed(1)}M) — likely wash trading`);
        result.warnings.push(`Vol too high $${(vol24h/1_000_000).toFixed(1)}M`);
        result.viable = false;
        return result;
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
        console.log(`  ⛔ ${tokenSymbol}: liquidity too high ($${(liq/1_000_000).toFixed(1)}M) — low yield potential`);
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

      // Volume scoring (already range-validated above)
      if (vol24h > 5_000_000) { result.score += 25; result.reasons.push(`Vol $${(vol24h/1_000_000).toFixed(1)}M`); }
      else if (vol24h > 500_000) { result.score += 20; result.reasons.push(`Vol $${(vol24h/1000).toFixed(0)}k`); }
      else { result.score += 10; result.reasons.push(`Vol $${(vol24h/1000).toFixed(0)}k`); }

      const priceChange = Math.abs(priceChangeRaw);
      if (priceChange > 50) { result.score += 20; result.reasons.push(`Volatile ${priceChange.toFixed(0)}%`); }
      else if (priceChange > 20) { result.score += 10; result.reasons.push(`Moving ${priceChange.toFixed(0)}%`); }

      // Liquidity scoring (already range-validated above)
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

      const mcap = pair.marketCap ?? pair.fdv ?? 0;
      if (mcap > 0) {
        if (mcap > 200_000_000) {
          // Hard reject: too large for meaningful meme/volatility yield
          console.log(`  ⛔ ${tokenSymbol}: mcap $${(mcap/1_000_000).toFixed(0)}M > $200M — reject`);
          result.warnings.push(`Large cap $${(mcap/1_000_000).toFixed(0)}M — not meme`);
          result.viable = false;
          return result;
        } else if (mcap < 100_000) {
          result.score -= 20;
          result.warnings.push(`Micro cap $${(mcap/1000).toFixed(0)}k — rug risk`);
        } else if (mcap < 10_000_000) {
          result.score += 15;
          result.reasons.push(`Small cap $${(mcap/1000).toFixed(0)}k`);
        } else {
          result.score += 5;
          result.reasons.push(`Mid cap $${(mcap/1_000_000).toFixed(0)}M`);
        }
        console.log(`  💰 Market cap for ${tokenSymbol} (not SOL): $${(mcap/1_000_000).toFixed(1)}M`);
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

    // Buy/sell ratio — bullish kalau lebih banyak buyer
    const buy24h = overview.buy24h ?? 0;
    const sell24h = overview.sell24h ?? 0;
    if (buy24h > sell24h * 1.2) { result.score += 10; result.reasons.push(`Buy pressure (${buy24h}B/${sell24h}S)`); }
    else if (sell24h > buy24h * 1.5) { result.score -= 15; result.warnings.push(`Sell pressure tinggi`); }

    console.log(`  🦅 Birdeye: holders=${holders} | wallets24h=${uniqueWallets24h} | buy/sell=${buy24h}/${sell24h}`);
  }

  if (security) {
    const topHolderPct = security.top10HolderPercent ?? 0;
    if (topHolderPct > 80) { result.score -= 20; result.warnings.push(`Top 10 holder ${(topHolderPct*100).toFixed(0)}% — rug risk!`); }
    else if (topHolderPct > 50) { result.score -= 10; result.warnings.push(`Concentrated ${(topHolderPct*100).toFixed(0)}%`); }
    else { result.score += 10; result.reasons.push(`Distributed holders`); }

    const mintable = security.mintAuthority !== null;
    const freezable = security.freezeAuthority !== null;
    if (mintable) { result.score -= 15; result.warnings.push("Mint authority aktif — rug risk!"); }
    if (freezable) { result.score -= 10; result.warnings.push("Freeze authority aktif"); }

    console.log(`  🔒 Security: top10=${(topHolderPct*100).toFixed(0)}% | mintable=${mintable} | freezable=${freezable}`);
  }

  const hasTwitterWarning = result.warnings.some(w => w.includes("Twitter"));
  const hasRugWarning = result.warnings.some(w => w.includes("rug") || w.includes("Mint authority"));
  result.viable = result.score >= 30 && !hasTwitterWarning && !hasRugWarning;

  console.log(`  ${result.viable ? "✅" : "❌"} Score=${result.score} | viable=${result.viable}`);
  if (result.reasons.length) console.log(`  ✅ ${result.reasons.join(", ")}`);
  if (result.warnings.length) console.log(`  ⚠️ ${result.warnings.join(", ")}`);

  return result;
}
