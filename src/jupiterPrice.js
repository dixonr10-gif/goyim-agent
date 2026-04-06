import fetch from "node-fetch";

const JUPITER_PRICE_API = "https://api.jup.ag/price/v2";
const priceCache = new Map();
const CACHE_TTL_MS = 30000;

export async function getTokenPrice(mintAddress) {
  const cached = priceCache.get(mintAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.price;
  try {
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${mintAddress}`);
    const data = await res.json();
    const price = data?.data?.[mintAddress]?.price ?? null;
    if (price !== null) priceCache.set(mintAddress, { price, timestamp: Date.now() });
    return price;
  } catch { return null; }
}

export async function checkPriceSync(pool, thresholdPct = 2) {
  return { isSynced: true, deviation: 0, reason: "price check skipped" };
}

export function formatPriceContext(pool, priceSync) {
  return `Price sync: ${priceSync.isSynced ? "OK" : "OUT OF SYNC"} | ${priceSync.reason}`;
}
