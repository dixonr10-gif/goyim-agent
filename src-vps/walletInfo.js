import { config } from "../config.js";

let _solPriceCache = { price: 0, fetchedAt: 0 };
const SOL_PRICE_TTL = 5 * 60 * 1000; // 5 min cache

let _idrRateCache = { rate: 0, fetchedAt: 0 };
const IDR_RATE_TTL = 30 * 60 * 1000; // 30 min cache

export async function getUsdToIdrRate() {
  if (Date.now() - _idrRateCache.fetchedAt < IDR_RATE_TTL && _idrRateCache.rate > 0) {
    return _idrRateCache.rate;
  }
  try {
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/USD", {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const rate = data?.rates?.IDR;
    if (typeof rate === "number" && rate > 10000) {
      _idrRateCache = { rate, fetchedAt: Date.now() };
      return rate;
    }
  } catch (e) {
    console.warn("[price] IDR rate fetch failed:", e.message);
  }
  return _idrRateCache.rate || 16300;
}

async function fetchTokenSymbol(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();
    const pairs = data?.pairs ?? [];
    const pair = pairs.find(p => p.baseToken?.address === mint) ?? pairs[0];
    if (!pair) return null;
    return pair.baseToken?.address === mint ? pair.baseToken.symbol : (pair.quoteToken?.symbol ?? null);
  } catch { return null; }
}

function isValidPrice(p) {
  return typeof p === "number" && p >= 10 && p <= 1000;
}

async function fetchFromCoinGecko() {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    { signal: AbortSignal.timeout(8000) }
  );
  const data = await res.json();
  const price = data?.solana?.usd;
  return typeof price === "number" ? price : 0;
}

async function fetchFromJupiter() {
  const WSOL = "So11111111111111111111111111111111111111112";
  const res = await fetch(
    `https://price.jup.ag/v6/price?ids=${WSOL}`,
    { signal: AbortSignal.timeout(8000) }
  );
  const data = await res.json();
  return data?.data?.[WSOL]?.price ?? 0;
}

export async function getSolPriceUSD() {
  if (Date.now() - _solPriceCache.fetchedAt < SOL_PRICE_TTL && isValidPrice(_solPriceCache.price)) {
    return _solPriceCache.price;
  }

  // Primary: CoinGecko
  try {
    const price = await fetchFromCoinGecko();
    if (isValidPrice(price)) {
      console.log(`[price] SOL: $${price.toFixed(2)} (source: coingecko)`);
      _solPriceCache = { price, fetchedAt: Date.now() };
      return price;
    }
    console.warn(`[price] CoinGecko returned invalid price: ${price}`);
  } catch (e) {
    console.warn("[price] CoinGecko failed:", e.message);
  }

  // Fallback: Jupiter
  try {
    const price = await fetchFromJupiter();
    if (isValidPrice(price)) {
      console.log(`[price] SOL: $${price.toFixed(2)} (source: jupiter)`);
      _solPriceCache = { price, fetchedAt: Date.now() };
      return price;
    }
    console.warn(`[price] Jupiter returned invalid price: ${price}`);
  } catch (e) {
    console.warn("[price] Jupiter failed:", e.message);
  }

  // Last known or hard fallback
  const fallback = isValidPrice(_solPriceCache.price) ? _solPriceCache.price : 84;
  console.warn(`[price] All sources failed — using fallback: $${fallback}`);
  return fallback;
}

export async function getWalletAddress() {
  const bs58 = await import("bs58");
  const { Keypair } = await import("@solana/web3.js");
  const wallet = Keypair.fromSecretKey(bs58.default.decode(config.walletPrivateKey));
  return wallet.publicKey.toString();
}

export async function getSOLBalance(walletAddress) {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [walletAddress] }),
  });
  const data = await res.json();
  return (data?.result?.value ?? 0) / 1e9;
}

export async function getTokenBalances(walletAddress) {
  try {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTokenAccountsByOwner",
        params: [walletAddress, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }],
      }),
    });
    const data = await res.json();
    const tokens = (data?.result?.value ?? [])
      .map(acc => ({ mint: acc.account.data.parsed.info.mint, amount: acc.account.data.parsed.info.tokenAmount.uiAmount }))
      .filter(t => t.amount > 0);
    // Fetch symbols in parallel
    const symbolResults = await Promise.allSettled(tokens.map(t => fetchTokenSymbol(t.mint)));
    return tokens.map((t, i) => ({ ...t, symbol: symbolResults[i]?.value ?? null }));
  } catch { return []; }
}

export function formatWalletMessage(address, solBalance, tokenBalances, solPriceUsd = 0, idrRate = 0) {
  const solUsd = (solBalance ?? 0) * solPriceUsd;
  const solIdr = solUsd * idrRate;

  let msg = "<b>👛 Wallet Agent</b>\n";
  msg += `<code>${address}</code>\n\n`;
  msg += `<b>💰 SOL:</b> <b>${solBalance?.toFixed(4) ?? "?"} SOL</b>\n`;
  if (solPriceUsd > 0) {
    msg += `≈ <b>$${solUsd.toFixed(2)}</b>`;
    if (idrRate > 0) msg += ` | <b>Rp${(solIdr / 1_000_000).toFixed(2)}jt</b>`;
    msg += ` <i>(SOL=$${solPriceUsd.toFixed(2)})</i>\n`;
    if (idrRate > 0) msg += `<i>Kurs: 1 USD = Rp${Math.round(idrRate).toLocaleString("id-ID")}</i>\n`;
  }
  if (tokenBalances.length > 0) {
    msg += `\n<b>🪙 Tokens (${tokenBalances.length}):</b>\n`;
    tokenBalances.slice(0, 5).forEach(t => {
      const label = t.symbol ? `<b>${t.symbol}</b>` : `<code>${t.mint.slice(0, 8)}...</code>`;
      msg += `• ${label}: ${t.amount?.toFixed(4)}\n`;
    });
  }
  return msg;
}

export function formatPnLMessage(stats, positions) {
  const s = stats?.stats ?? {};
  let msg = "<b>📈 P&L Summary</b>\n";
  msg += `Total: <b>${s.totalPnlSol ?? 0} SOL</b>\n`;
  msg += `Win rate: <b>${s.hitRate ?? 0}%</b>\n`;
  return msg;
}

