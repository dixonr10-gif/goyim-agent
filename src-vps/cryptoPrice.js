const SYMBOL_MAP = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  AVAX: "avalanche-2",
  MATIC: "matic-network",
  POL: "matic-network",
  DOT: "polkadot",
  LINK: "chainlink",
  UNI: "uniswap",
  ATOM: "cosmos",
  LTC: "litecoin",
  SHIB: "shiba-inu",
  TRX: "tron",
  TON: "the-open-network",
  SUI: "sui",
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism",
  NEAR: "near",
  FTM: "fantom",
  ALGO: "algorand",
  VET: "vechain",
  ICP: "internet-computer",
  FIL: "filecoin",
  HBAR: "hedera-hashgraph",
  XLM: "stellar",
  SAND: "the-sandbox",
  MANA: "decentraland",
  AXS: "axie-infinity",
  THETA: "theta-token",
  EOS: "eos",
  AAVE: "aave",
  MKR: "maker",
  SNX: "synthetix-network-token",
  COMP: "compound-governance-token",
  CRV: "curve-dao-token",
  SUSHI: "sushi",
  YFI: "yearn-finance",
  INJ: "injective-protocol",
  SEI: "sei-network",
  JUP: "jupiter-exchange-solana",
  BONK: "bonk",
  WIF: "dogwifcoin",
  PYTH: "pyth-network",
  JTO: "jito-governance-token",
  RENDER: "render-token",
  WLD: "worldcoin-wld",
  PEPE: "pepe",
  FLOKI: "floki",
  PENGU: "pudgy-penguins",
  TRUMP: "maga",
  ANIME: "anime-token",
};

// cache: key -> { data, timestamp }
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

async function searchCoinGeckoId(symbol) {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const coins = data?.coins ?? [];
    const exact = coins.find(c => c.symbol?.toUpperCase() === symbol.toUpperCase());
    return exact?.id ?? coins[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function getCryptoPrice(symbol) {
  const sym = symbol.toUpperCase();
  const cacheKey = `price_${sym}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  let coinId = SYMBOL_MAP[sym];
  if (!coinId) coinId = await searchCoinGeckoId(sym);
  if (!coinId) return { symbol: sym, price: null, change24h: null, source: "not_found" };

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { symbol: sym, price: null, change24h: null, source: "error" };

    const data = await res.json();
    const coinData = data[coinId];
    if (!coinData) return { symbol: sym, price: null, change24h: null, source: "not_found" };

    const result = {
      symbol: sym,
      price: coinData.usd,
      change24h: coinData.usd_24h_change ?? null,
      source: "coingecko",
    };
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch {
    return { symbol: sym, price: null, change24h: null, source: "error" };
  }
}

export async function getTopCryptos(limit = 10) {
  const cacheKey = `top_${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) return cached.data;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return [];

    const coins = await res.json();
    const result = coins.slice(0, limit).map(c => ({
      name: c.name,
      symbol: c.symbol?.toUpperCase(),
      price: c.current_price,
      change24h: c.price_change_percentage_24h ?? null,
    }));
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch {
    return [];
  }
}

export function formatPriceEntry(coin) {
  if (!coin || coin.price == null) return null;
  const price = coin.price >= 1
    ? `$${coin.price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${coin.price.toFixed(6)}`;
  const change = coin.change24h != null
    ? ` (24h: ${coin.change24h >= 0 ? "+" : ""}${coin.change24h.toFixed(2)}%)`
    : "";
  return `${coin.symbol}: ${price}${change}`;
}
