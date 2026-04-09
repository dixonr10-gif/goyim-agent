// src-vps/technicalAnalysis.js
// Technical Analysis: RSI(14) + EMA(20) filter for entry decisions
// Data source: DexScreener priceChange data (from pool enrichment or API)

/**
 * Build synthetic candles from DexScreener pair data.
 * @param {object} pair - DexScreener pair object with priceUsd and priceChange
 * @returns {Array|null} 20 synthetic candles or null
 */
function buildSyntheticCandles(pair) {
  const priceNow = parseFloat(pair?.priceUsd ?? "0");
  if (!priceNow || priceNow <= 0) return null;

  const m5 = parseFloat(pair.priceChange?.m5 ?? "0");
  const h1 = parseFloat(pair.priceChange?.h1 ?? "0");
  const h6 = parseFloat(pair.priceChange?.h6 ?? "0");
  const h24 = parseFloat(pair.priceChange?.h24 ?? "0");

  // Estimate historical prices from percentage changes
  const p1h = priceNow / (1 + h1 / 100);
  const p5m = priceNow / (1 + m5 / 100);

  // Per-candle volatility proportional to hourly price movement
  // In real markets even uptrends have red candles — this creates realistic RSI
  const hourlyVol = Math.abs(h1) / 100;
  const candleVol = Math.max(0.005, Math.min(0.10, hourlyVol * 0.4)); // 0.5%–10%, ~40% of hourly move

  // 20 candles of 5min each = 100min of data
  // Interpolate from ~1h40m ago to now, with market-realistic noise
  const candles = [];
  for (let i = 0; i < 20; i++) {
    const t = i / 19; // 0 to 1
    let trendPrice;
    if (t < 0.4) {
      trendPrice = p1h + (p5m - p1h) * (t / 0.4);
    } else {
      trendPrice = p5m + (priceNow - p5m) * ((t - 0.4) / 0.6);
    }
    // Add realistic volatility noise — creates both up and down candles
    const noise = (Math.random() - 0.5) * 2 * candleVol;
    const close = trendPrice * (1 + noise);
    const spread = trendPrice * candleVol * 0.5;
    candles.push({
      open: close + (Math.random() - 0.5) * spread,
      high: close + Math.random() * spread,
      low: close - Math.random() * spread,
      close,
      volume: 0,
    });
  }
  // Pin last candle to actual current price
  candles[candles.length - 1].close = priceNow;
  return candles;
}

/**
 * Get candles for TA calculation.
 * Primary: use dexPair data already fetched during pool enrichment (poolScanner).
 * Fallback: fetch from DexScreener search API if no enriched data.
 * @param {string} pairAddress - Meteora pool address
 * @param {object|null} dexPair - DexScreener pair object from pool enrichment
 */
export async function getCandles(pairAddress, dexPair = null) {
  // Primary path: use enriched dexPair data (already fetched by poolScanner)
  if (dexPair) {
    const candles = buildSyntheticCandles(dexPair);
    if (candles) return candles;
  }

  // Fallback: fetch via DexScreener search (direct /pairs/ doesn't work for Meteora addresses)
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/search?q=${pairAddress}`,
      { signal: AbortSignal.timeout(8000), headers: { "Accept": "application/json" } }
    );
    const data = await res.json();
    const pair = data?.pairs?.[0];
    if (pair) return buildSyntheticCandles(pair);
  } catch (err) {
    console.log(`  [TA] Search fallback error for ${pairAddress?.slice(0, 8)}...: ${err.message}`);
  }

  return null;
}

export function calculateRSI(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;

  const closes = candles.map(c => c.close);
  let gains = 0;
  let losses = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothed for remaining candles
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calculateEMA(candles, period = 20) {
  if (!candles || candles.length < period) return null;

  const closes = candles.map(c => c.close);
  const multiplier = 2 / (period + 1);

  // SMA for seed
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

  // EMA for remaining periods
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * multiplier + ema;
  }

  return ema;
}

export function getTASignal(candles) {
  if (!candles || candles.length < 15) {
    return { rsi: null, ema20: null, currentPrice: null, signal: "NEUTRAL", reason: "insufficient candle data" };
  }

  const rsi = calculateRSI(candles);
  const ema20 = calculateEMA(candles);
  const currentPrice = candles[candles.length - 1].close;

  if (rsi === null || ema20 === null) {
    return { rsi, ema20, currentPrice, signal: "NEUTRAL", reason: "calculation failed" };
  }

  // RSI > 80 → overbought, skip
  if (rsi > 80) {
    return { rsi, ema20, currentPrice, signal: "SKIP", reason: `overbought RSI ${rsi.toFixed(1)}` };
  }
  // RSI < 30 → oversold / dumping, skip
  if (rsi < 30) {
    return { rsi, ema20, currentPrice, signal: "SKIP", reason: `oversold/dumping RSI ${rsi.toFixed(1)}` };
  }

  // EMA20 still computed and included for LLM context, but NOT used as filter
  // DLMM LP benefits from sideways markets — EMA filter would skip good opportunities
  return { rsi, ema20, currentPrice, signal: "BUY", reason: `RSI ${rsi.toFixed(1)} neutral` };
}
