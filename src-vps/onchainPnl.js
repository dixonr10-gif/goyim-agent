// src/onchainPnl.js — On-chain PnL tracker via Helius Parsed Transactions API
import { config } from "../config.js";
import { getWalletAddress, getSolPriceUSD } from "./walletInfo.js";

function getHeliusKey() {
  const match = config.rpcUrl?.match(/api-key=([a-f0-9-]+)/i);
  return match?.[1] ?? process.env.HELIUS_API_KEY ?? null;
}

// ── Cache ────────────────────────────────────────────────────────────
const cache = { data: null, fetchedAt: 0 };
const CACHE_TTL = 300_000; // 5 minutes

// ── Token price cache (batch fetch) ─────────────────────────────────
const priceCache = new Map(); // mint → { price, fetchedAt }
const PRICE_TTL = 60_000; // 1 minute

async function fetchTokenPrices(mints) {
  const fresh = [];
  const now = Date.now();
  for (const m of mints) {
    const c = priceCache.get(m);
    if (!c || now - c.fetchedAt > PRICE_TTL) fresh.push(m);
  }
  if (fresh.length > 0) {
    // Batch fetch up to 100 mints at once
    for (let i = 0; i < fresh.length; i += 100) {
      const batch = fresh.slice(i, i + 100);
      try {
        const res = await fetch(`https://lite.jupiterapi.com/price?ids=${batch.join(",")}`, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const data = await res.json();
          for (const mint of batch) {
            const price = data?.data?.[mint]?.price ?? null;
            priceCache.set(mint, { price, fetchedAt: Date.now() });
          }
        }
      } catch (err) {
        console.log(`[OnchainPnl] Jupiter price fetch error: ${err.message}`);
      }
    }
  }
  const result = {};
  for (const m of mints) {
    result[m] = priceCache.get(m)?.price ?? null;
  }
  return result;
}

// ── 1. Fetch All Transactions ────────────────────────────────────────
export async function fetchAllTransactions(daysBack = 30) {
  if (cache.data && Date.now() - cache.fetchedAt < CACHE_TTL) {
    console.log(`[OnchainPnl] Using cached data (${cache.data.length} txs)`);
    return cache.data;
  }

  const heliusKey = getHeliusKey();
  if (!heliusKey) { console.log("[OnchainPnl] No Helius API key found"); return []; }

  const wallet = await getWalletAddress();
  const cutoff = Date.now() / 1000 - daysBack * 86400;
  const allTxs = [];
  let before = undefined;
  let page = 0;
  const maxPages = 20; // FIX 2: 20 pages × 100 = 2000 max (was 10)

  console.log(`[OnchainPnl] Fetching transactions (${daysBack} days back)...`);

  while (page < maxPages) {
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${heliusKey}&limit=100${before ? `&before=${before}` : ""}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) { console.log(`[OnchainPnl] Helius HTTP ${res.status}`); break; }
      const txs = await res.json();
      if (!Array.isArray(txs) || txs.length === 0) break;
      allTxs.push(...txs);
      before = txs[txs.length - 1].signature;
      if (txs[txs.length - 1].timestamp < cutoff) break;
      page++;
    } catch (err) {
      console.log(`[OnchainPnl] Fetch error page ${page}: ${err.message}`);
      break;
    }
  }

  allTxs.sort((a, b) => b.timestamp - a.timestamp);
  console.log(`[OnchainPnl] Fetched ${allTxs.length} transactions (${page + 1} pages)`);

  cache.data = allTxs;
  cache.fetchedAt = Date.now();
  return allTxs;
}

// ── Helper: find Meteora instruction (top-level or inner) ────────────
function findMeteoraInstr(tx) {
  const top = tx.instructions?.find(i => i.programId?.startsWith("LBUZKh"));
  if (top) return top;
  for (const inst of tx.instructions ?? []) {
    const inner = inst.innerInstructions?.find(ii => ii.programId?.startsWith("LBUZKh"));
    if (inner) return inner;
  }
  return null;
}

// ── 2. Parse Trades ──────────────────────────────────────────────────
export async function parseTrades(transactions, walletAddress) {
  const openMap = new Map();
  const swaps = [];

  for (const tx of transactions) {
    if (tx.type === "INITIALIZE_POSITION") {
      const meteoraInstr = findMeteoraInstr(tx);
      if (!meteoraInstr) continue;
      const positionPDA = meteoraInstr.accounts?.[1];
      const poolAddress = meteoraInstr.accounts?.[2];
      if (!positionPDA) continue;
      const solDeployed = (tx.tokenTransfers ?? [])
        .filter(t => t.fromUserAccount === walletAddress && t.mint?.startsWith("So1111"))
        .reduce((s, t) => s + (t.tokenAmount ?? 0), 0);
      if (solDeployed < 0.01) continue;
      openMap.set(positionPDA, {
        signature: tx.signature, timestamp: tx.timestamp,
        openedAt: new Date(tx.timestamp * 1000).toISOString(),
        solDeployed, positionPDA, poolAddress,
      });
    } else if (tx.type === "SWAP") {
      const solIn = (tx.tokenTransfers ?? [])
        .filter(t => t.toUserAccount === walletAddress && t.mint?.startsWith("So1111"))
        .reduce((s, t) => s + (t.tokenAmount ?? 0), 0);
      const tokenOut = (tx.tokenTransfers ?? [])
        .find(t => t.fromUserAccount === walletAddress && !t.mint?.startsWith("So1111"));
      if (solIn < 0.001) continue;
      swaps.push({
        signature: tx.signature, timestamp: tx.timestamp,
        solFromSwap: solIn, tokenMint: tokenOut?.mint ?? null,
      });
    }
  }

  // First pass: collect closes and match swaps
  const rawCloses = [];
  const usedSwaps = new Set();

  for (const tx of transactions) {
    if (tx.type !== "CLOSE_ACCOUNT") continue;
    const meteoraInstr = findMeteoraInstr(tx);
    if (!meteoraInstr) continue;
    const positionPDA = meteoraInstr.accounts?.[0];
    const poolAddress = meteoraInstr.accounts?.[1];
    const matchedOpen = openMap.get(positionPDA);
    if (!matchedOpen) continue;
    openMap.delete(positionPDA);

    const solReturned = (tx.tokenTransfers ?? [])
      .filter(t => t.toUserAccount === walletAddress && t.mint?.startsWith("So1111"))
      .reduce((s, t) => s + (t.tokenAmount ?? 0), 0);

    // All alt tokens returned to wallet (position tokens + fee tokens)
    const altTokens = (tx.tokenTransfers ?? [])
      .filter(t => t.toUserAccount === walletAddress && !t.mint?.startsWith("So1111"));

    // Group alt tokens by mint → sum amounts
    const altByMint = {};
    for (const t of altTokens) {
      if (!t.mint) continue;
      altByMint[t.mint] = (altByMint[t.mint] ?? 0) + (t.tokenAmount ?? 0);
    }

    // Find matching SWAP
    let matchedSwap = null;
    const altMint = altTokens[0]?.mint ?? null;
    if (altMint) {
      for (const swap of swaps) {
        if (usedSwaps.has(swap.signature)) continue;
        const diff = swap.timestamp - tx.timestamp;
        if (diff >= -5 && diff <= 300 && swap.tokenMint === altMint) {
          if (!matchedSwap || Math.abs(diff) < Math.abs(matchedSwap.timestamp - tx.timestamp)) matchedSwap = swap;
        }
      }
    }
    if (!matchedSwap) {
      for (const swap of swaps) {
        if (usedSwaps.has(swap.signature)) continue;
        const diff = swap.timestamp - tx.timestamp;
        if (diff >= 0 && diff <= 60) {
          if (!matchedSwap || diff < (matchedSwap.timestamp - tx.timestamp)) matchedSwap = swap;
        }
      }
    }
    if (matchedSwap) usedSwaps.add(matchedSwap.signature);

    rawCloses.push({
      tx, matchedOpen, matchedSwap, solReturned, altByMint, altMint,
      positionPDA, poolAddress,
    });
  }

  // FIX 1: Batch-fetch prices for all unswapped tokens
  const mintsToPrice = new Set();
  for (const c of rawCloses) {
    if (!c.matchedSwap && c.altMint) {
      for (const mint of Object.keys(c.altByMint)) mintsToPrice.add(mint);
    }
  }
  const solPrice = await getSolPriceUSD();
  let tokenPrices = {};
  if (mintsToPrice.size > 0) {
    tokenPrices = await fetchTokenPrices([...mintsToPrice]);
  }

  // Second pass: compute PnL
  const trades = [];
  for (const c of rawCloses) {
    const { matchedOpen, matchedSwap, solReturned, altByMint, altMint, positionPDA, poolAddress, tx } = c;

    let solFromSwap = matchedSwap?.solFromSwap ?? 0;
    let tokenValueSol = 0;
    let hasUnknownToken = false;

    // FIX 1: If no swap matched, value alt tokens via Jupiter price
    if (!matchedSwap && altMint) {
      for (const [mint, amount] of Object.entries(altByMint)) {
        const priceUsd = tokenPrices[mint];
        if (priceUsd && priceUsd > 0 && solPrice > 0) {
          tokenValueSol += (amount * priceUsd) / solPrice;
        } else {
          console.log(`[OnchainPnl] Unknown token price for ${mint.slice(0, 8)}, using $0`);
          hasUnknownToken = true;
        }
      }
    }

    // FIX 3: Add fee tokens value (when swap DID match, fees are the 2nd+ transfers of same mint)
    // Fee tokens are already included in altByMint total — swap covers main amount,
    // but if there are multiple transfers of the same alt token (position + fees),
    // the swap only converts the combined amount. So fees are already captured in swap.

    const totalSolReturned = solReturned + solFromSwap + tokenValueSol;
    const pnlSol = totalSolReturned - matchedOpen.solDeployed;
    const pnlPercent = matchedOpen.solDeployed > 0 ? (pnlSol / matchedOpen.solDeployed) * 100 : 0;

    // FIX 4: Lower BE threshold from 0.001 to 0.0001
    const outcome = pnlSol > 0.0001 ? "win" : pnlSol < -0.0001 ? "loss" : "breakeven";

    trades.push({
      openSig: matchedOpen.signature,
      closeSig: tx.signature,
      swapSig: matchedSwap?.signature ?? null,
      positionPDA,
      poolAddress: poolAddress ?? matchedOpen.poolAddress,
      openedAt: matchedOpen.openedAt,
      closedAt: new Date(tx.timestamp * 1000).toISOString(),
      solDeployed: matchedOpen.solDeployed,
      solReturned,
      solFromSwap,
      tokenValueSol,
      totalSolReturned,
      pnlSol,
      pnlPercent,
      outcome,
      hasSwap: !!matchedSwap,
      hasUnknownToken,
      holdMinutes: ((tx.timestamp - matchedOpen.timestamp) / 60).toFixed(1),
    });
  }

  trades.sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  return trades;
}

// ── 3. Match Claim Fees ──────────────────────────────────────────────
export function matchClaimFees(transactions) {
  const fees = [];
  for (const tx of transactions) {
    const desc = (tx.description ?? "").toLowerCase();
    const type = (tx.type ?? "").toLowerCase();
    if (!desc.includes("claim") && !type.includes("claim")) continue;
    const walletAcc = tx.accountData?.find(a => a.nativeBalanceChange > 0);
    if (!walletAcc) continue;
    fees.push({
      timestamp: tx.timestamp,
      date: new Date(tx.timestamp * 1000).toISOString().slice(0, 10),
      solClaimed: walletAcc.nativeBalanceChange / 1e9,
    });
  }
  const byDate = {};
  for (const f of fees) byDate[f.date] = (byDate[f.date] ?? 0) + f.solClaimed;
  return { entries: fees, byDate, totalSol: fees.reduce((s, f) => s + f.solClaimed, 0) };
}

// ── 4. Get On-chain Stats ────────────────────────────────────────────
export async function getOnchainStats(period = "daily") {
  try {
    const txs = await fetchAllTransactions(30);
    if (txs.length === 0) return null;

    const wallet = await getWalletAddress();
    const trades = await parseTrades(txs, wallet);
    const feeData = matchClaimFees(txs);
    const solPrice = await getSolPriceUSD();

    const now = new Date();
    let startDate;
    if (period === "daily") {
      startDate = new Date(now); startDate.setUTCHours(0, 0, 0, 0);
    } else if (period === "weekly") {
      startDate = new Date(now.getTime() - 7 * 86400000); startDate.setUTCHours(0, 0, 0, 0);
    } else {
      startDate = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
    }

    const filtered = trades.filter(t => new Date(t.closedAt) >= startDate);
    const wins = filtered.filter(t => t.outcome === "win");
    const losses = filtered.filter(t => t.outcome === "loss");

    const totalPnlSol = filtered.reduce((s, t) => s + t.pnlSol, 0);
    const totalPnlUsd = totalPnlSol * solPrice;

    const startStr = startDate.toISOString().slice(0, 10);
    const periodFees = Object.entries(feeData.byDate)
      .filter(([d]) => d >= startStr)
      .reduce((s, [, v]) => s + v, 0);

    const bestTrade = filtered.length > 0 ? filtered.reduce((a, b) => a.pnlSol > b.pnlSol ? a : b) : null;
    const worstTrade = filtered.length > 0 ? filtered.reduce((a, b) => a.pnlSol < b.pnlSol ? a : b) : null;

    return {
      period, startDate: startDate.toISOString(),
      totalPnlSol, totalPnlUsd,
      totalTrades: filtered.length,
      wins: wins.length, losses: losses.length,
      breakeven: filtered.length - wins.length - losses.length,
      winRate: filtered.length > 0 ? ((wins.length / filtered.length) * 100).toFixed(1) : "0.0",
      avgWinSol: wins.length > 0 ? (wins.reduce((s, t) => s + t.pnlSol, 0) / wins.length) : 0,
      avgLossSol: losses.length > 0 ? (losses.reduce((s, t) => s + t.pnlSol, 0) / losses.length) : 0,
      totalFeesSol: periodFees, totalFeesUsd: periodFees * solPrice,
      bestTrade: bestTrade ? { pnlSol: bestTrade.pnlSol, pnlPercent: bestTrade.pnlPercent, pool: bestTrade.poolAddress } : null,
      worstTrade: worstTrade ? { pnlSol: worstTrade.pnlSol, pnlPercent: worstTrade.pnlPercent, pool: worstTrade.poolAddress } : null,
      solPrice, trades: filtered,
    };
  } catch (err) {
    console.log(`[OnchainPnl] getOnchainStats error: ${err.message}`);
    return null;
  }
}

// ── 5. Get PnL By Day ───────────────────────────────────────────────
export async function getOnchainPnlByDay(month, year) {
  try {
    const txs = await fetchAllTransactions(30);
    if (txs.length === 0) return [];

    const wallet = await getWalletAddress();
    const trades = await parseTrades(txs, wallet);
    const solPrice = await getSolPriceUSD();

    const filtered = trades.filter(t => {
      const d = new Date(t.closedAt);
      if (month !== undefined && d.getUTCMonth() !== month) return false;
      if (year !== undefined && d.getUTCFullYear() !== year) return false;
      return true;
    });

    const dayMap = {};
    for (const t of filtered) {
      const date = t.closedAt.slice(0, 10);
      if (!dayMap[date]) dayMap[date] = { date, pnlSol: 0, pnlUsd: 0, trades: 0, wins: 0, losses: 0 };
      dayMap[date].pnlSol += t.pnlSol;
      dayMap[date].pnlUsd += t.pnlSol * solPrice;
      dayMap[date].trades++;
      if (t.outcome === "win") dayMap[date].wins++;
      if (t.outcome === "loss") dayMap[date].losses++;
    }

    const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
    for (const d of days) d.winRate = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(1) : "0.0";
    return days;
  } catch (err) {
    console.log(`[OnchainPnl] getOnchainPnlByDay error: ${err.message}`);
    return [];
  }
}

// ── 6. Clear cache ───────────────────────────────────────────────────
export function clearOnchainCache() {
  cache.data = null;
  cache.fetchedAt = 0;
}
