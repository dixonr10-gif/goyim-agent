import fetch from "node-fetch";

const METEORA_API = "https://dlmm.datapi.meteora.ag";

export async function analyzePool(pool) {
  const vol24h = pool.volume?.["24h"] ?? 0;
  const vol1h = pool.volume?.["1h"] ?? 0;
  const vol4h = pool.volume?.["4h"] ?? 0;
  const apr = (pool.apr ?? 0) * 100;
  const tvl = pool.tvl ?? 0;
  const fees24h = pool.fees?.["24h"] ?? 0;

  const volatility = estimateVolatility(vol1h, vol4h, vol24h);
  const trend = estimateTrend(pool);
  const feeMomentum = estimateFeeMomentum(pool);
  const score = calculateScore({ vol24h, apr, tvl, volatility, feeMomentum, pool });

  return {
    poolAddress: pool.address,
    poolName: pool.name,
    volatility,
    trend,
    feeMomentum,
    opportunityScore: score,
    suggestedBinRange: suggestBinRange(volatility),
    summary: `${pool.name}: APR=${apr.toFixed(1)}% vol24h=$${Math.round(vol24h).toLocaleString()} score=${score}`,
  };
}

function estimateVolatility(vol1h, vol4h, vol24h) {
  if (!vol1h || !vol24h) return { value: "0", level: "unknown" };
  const avgHourly = vol24h / 24;
  const deviation = Math.abs(vol1h - avgHourly) / avgHourly * 100;
  const level = deviation < 20 ? "low" : deviation < 60 ? "medium" : "high";
  return { value: deviation.toFixed(1), level };
}

function estimateTrend(pool) {
  const vol1h = pool.volume?.["1h"] ?? 0;
  const vol4h = pool.volume?.["4h"] ?? 0;
  if (!vol1h || !vol4h) return { direction: "sideways", change: "0" };
  const avgRecent = vol1h * 4;
  const change = ((avgRecent - vol4h) / vol4h) * 100;
  const direction = change > 10 ? "uptrend" : change < -10 ? "downtrend" : "sideways";
  return { direction, change: change.toFixed(1) };
}

function estimateFeeMomentum(pool) {
  const fees1h = pool.fees?.["1h"] ?? 0;
  const fees4h = pool.fees?.["4h"] ?? 0;
  if (!fees1h || !fees4h) return { trend: "stable", signal: "neutral" };
  const avgRecent = fees1h * 4;
  const change = ((avgRecent - fees4h) / fees4h) * 100;
  const trend = change > 10 ? "increasing" : change < -10 ? "decreasing" : "stable";
  const signal = change > 10 ? "bullish" : change < -20 ? "bearish" : "neutral";
  return { trend, signal, change: change.toFixed(1) };
}

function calculateScore({ vol24h, apr, tvl, volatility, feeMomentum, pool }) {
  let score = 40;
  if (apr > 50) score += 20;
  else if (apr > 20) score += 12;
  else if (apr > 10) score += 6;
  if (vol24h > 1_000_000) score += 15;
  else if (vol24h > 100_000) score += 8;
  else if (vol24h > 10_000) score += 4;
  if (volatility.level === "medium") score += 8;
  else if (volatility.level === "low") score += 5;
  else if (volatility.level === "high") score += 3; // volatile = more LP fees
  if (feeMomentum.signal === "bullish") score += 8;
  else if (feeMomentum.signal === "bearish") score -= 8;
  if (tvl > 500_000) score += 5;
  score -= (pool.riskScore ?? 0) * 0.2;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function suggestBinRange(volatility) {
  if (volatility.level === "low") return { lower: -5, upper: 5 };
  if (volatility.level === "medium") return { lower: -15, upper: 15 };
  return { lower: -30, upper: 30 };
}
