// src-vps/autoSwap.js
// Auto-swap received SPL tokens to SOL after position close via Jupiter

import { createRequire } from "module";
import { config } from "../config.js";
import { getWallet, getConnection } from "./positionManager.js";

const require = createRequire(import.meta.url);

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const JUP_QUOTE_URL = "https://public.jupiterapi.com/quote";
const JUP_SWAP_URL  = "https://public.jupiterapi.com/swap";

import fs from "fs";
import path from "path";

const AUTO_SWAP_ENABLED = process.env.AUTO_SWAP_ENABLED !== "false";
const AUTO_SWAP_MIN_USD = Number(process.env.AUTO_SWAP_MIN_USD) || 1;
const PENDING_SWAPS_FILE = path.resolve("data/pending_swaps.json");
const FAILED_SWAPS_FILE  = path.resolve("data/failed_swaps.json");
const FAIL_COOLDOWN_MS        = 24 * 60 * 60 * 1000; // slippage 3x fail → 24h
const NO_ROUTES_COOLDOWN_MS   =  2 * 60 * 60 * 1000; // route depth gap → 2h (liquidity can recover fast)

function loadPendingSwaps() {
  try { return JSON.parse(fs.readFileSync(PENDING_SWAPS_FILE, "utf-8")); } catch { return []; }
}
function savePendingSwaps(swaps) {
  try { fs.mkdirSync(path.dirname(PENDING_SWAPS_FILE), { recursive: true }); fs.writeFileSync(PENDING_SWAPS_FILE, JSON.stringify(swaps, null, 2)); } catch {}
}
function addPendingSwap(tokenMint, amount, usdValue) {
  const pending = loadPendingSwaps();
  // Don't duplicate
  if (pending.some(s => s.tokenMint === tokenMint)) return;
  pending.push({ tokenMint, amount, usdValue, failedAt: new Date().toISOString(), retries: 0, nextRetryAt: 0, alertSent: false });
  savePendingSwaps(pending);
}
function removePendingSwap(tokenMint) {
  const pending = loadPendingSwaps().filter(s => s.tokenMint !== tokenMint);
  savePendingSwaps(pending);
}

// Hard-fail cache: after 3 attempts we stop retrying a mint for 24h so the
// logs don't get flooded with the same failed swap (rug/frozen tokens, etc.).
function loadFailedSwaps() {
  try { return JSON.parse(fs.readFileSync(FAILED_SWAPS_FILE, "utf-8")); } catch { return []; }
}
function saveFailedSwaps(swaps) {
  try { fs.mkdirSync(path.dirname(FAILED_SWAPS_FILE), { recursive: true }); fs.writeFileSync(FAILED_SWAPS_FILE, JSON.stringify(swaps, null, 2)); } catch {}
}
function addFailedSwap({ symbol, tokenMint, amount, reason, cooldownMs }) {
  const list = loadFailedSwaps().filter(s => s.tokenMint !== tokenMint);
  list.push({
    symbol: symbol ?? null,
    tokenMint,
    amount,
    failedAt: new Date().toISOString(),
    reason: reason ?? null,
    cooldownMs: cooldownMs ?? FAIL_COOLDOWN_MS,
  });
  saveFailedSwaps(list);
}
function isFailedRecently(tokenMint) {
  const list = loadFailedSwaps();
  const match = list.find(s => s.tokenMint === tokenMint);
  if (!match?.failedAt) return false;
  const window = match.cooldownMs ?? FAIL_COOLDOWN_MS;
  return (Date.now() - new Date(match.failedAt).getTime()) < window;
}

async function fetchDexScreenerPrice(mint) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    // Pick the pair with highest liquidity for most accurate price
    const pairs = (data?.pairs ?? []).filter(p => parseFloat(p.priceUsd ?? "0") > 0);
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const price = parseFloat(pairs[0]?.priceUsd ?? "0");
    const symbol = pairs[0]?.baseToken?.symbol ?? null;
    return { price, symbol };
  } catch {
    return { price: 0, symbol: null };
  }
}

// Estimate USD value via Jupiter quote (fallback when DexScreener has no price)
// Swap 1% of amount to get a price signal, use SOL price $150 as floor estimate
async function estimateUsdViaJupiterQuote(mint, rawAmount, uiAmount) {
  try {
    // Use a small sample (1000 raw units) to test if Jupiter can route
    const sampleAmount = Math.min(parseInt(rawAmount), 1_000_000);
    if (sampleAmount <= 0) return 0;
    const url = `${JUP_QUOTE_URL}?inputMint=${mint}&outputMint=${WSOL}&amount=${sampleAmount}&slippageBps=300`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return 0;
    const quote = await res.json();
    if (quote.error || !quote.outAmount) return 0;
    // outAmount is in lamports (SOL * 1e9)
    const solOut = parseInt(quote.outAmount) / 1e9;
    // Scale to full amount
    const fullSolValue = solOut * (parseInt(rawAmount) / sampleAmount);
    const SOL_PRICE_USD = 130; // conservative estimate
    return fullSolValue * SOL_PRICE_USD;
  } catch {
    return 0;
  }
}

async function fetchWithRateRetry(fn, label = "Jupiter") {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.message?.includes("429") || err.message?.includes("Too Many Requests");
      if (is429 && attempt < 3) {
        const wait = 3000 * attempt;
        console.log(`  [${label}] 429 rate limited — retry ${attempt}/3 in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function getJupiterQuote(inputMint, amount, slippageBps = 100) {
  return fetchWithRateRetry(async () => {
    const url = `${JUP_QUOTE_URL}?inputMint=${inputMint}&outputMint=${WSOL}&amount=${amount}&slippageBps=${slippageBps}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status} ${await res.text().catch(() => "")}`);
    const quote = await res.json();
    if (quote.error) throw new Error(`Jupiter quote error: ${quote.error}`);
    return quote;
  }, "JupQuote");
}

async function buildJupiterSwapTx(quoteResponse, userPublicKey) {
  return fetchWithRateRetry(async () => {
    const res = await fetch(JUP_SWAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Jupiter swap build failed: ${res.status} ${await res.text().catch(() => "")}`);
    const data = await res.json();
    if (!data.swapTransaction) throw new Error("Jupiter returned no swapTransaction");
    return data.swapTransaction;
  }, "JupSwap");
}

async function notifyTemp(msg) {
  try { const { notifyTemporary } = await import("./telegramBot.js"); await notifyTemporary(msg, 10000); } catch {}
}

export async function autoSwapTokensToSOL(notifyFn = null) {
  if (!AUTO_SWAP_ENABLED) {
    console.log("[autoSwap] Disabled via AUTO_SWAP_ENABLED=false");
    return;
  }

  console.log("🔄 Starting auto-swap check...");

  try {
    const { PublicKey, VersionedTransaction } = require("@solana/web3.js");
    const wallet = await getWallet();
    const connection = getConnection();

    // Force fresh data: get latest blockhash first, then fetch with confirmed commitment
    await connection.getLatestBlockhash("confirmed");

    // Get all SPL token accounts (both Token Program AND Token-2022) — retry if empty
    let tokenAccounts = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const [legacy, token2022] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey(TOKEN_PROGRAM_ID) }, { commitment: "confirmed" }),
        connection.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: new PublicKey(TOKEN_2022_PROGRAM_ID) }, { commitment: "confirmed" }).catch(() => ({ value: [] })),
      ]);
      tokenAccounts = [...(legacy?.value ?? []), ...(token2022?.value ?? [])];
      const nonZero = tokenAccounts.filter(a => (a.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0) > 0);
      if (nonZero.length > 0 || attempt >= 2) break;
      console.log(`[autoSwap] No tokens found (attempt ${attempt}), waiting 10s...`);
      await new Promise(r => setTimeout(r, 10000));
    }

    const tokens = tokenAccounts
      .map(acc => {
        const info = acc.account.data.parsed?.info;
        return {
          mint: info?.mint,
          amount: info?.tokenAmount?.amount,
          uiAmount: info?.tokenAmount?.uiAmount ?? 0,
          decimals: info?.tokenAmount?.decimals ?? 0,
          ata: acc.pubkey.toString(),
        };
      })
      .filter(t => t.mint && t.mint !== WSOL && parseInt(t.amount) > 0);

    console.log(`💰 Found ${tokens.length} SPL token(s) to check`);
    for (const t of tokens) {
      console.log(`  • ${t.mint.slice(0, 8)}... | amount=${t.uiAmount} | decimals=${t.decimals}`);
    }

    if (tokens.length === 0) {
      console.log("[autoSwap] No non-SOL tokens in wallet — nothing to swap.");
      return;
    }

    // Price check via DexScreener, fallback to Jupiter quote estimate
    const swappable = [];
    for (const t of tokens) {
      const mintShort = t.mint.slice(0, 8);
      // Skip tokens that already hard-failed in the last 24h so we don't
      // flood logs with the same dead swap every healer cycle.
      if (isFailedRecently(t.mint)) {
        console.log(`[AutoSwap] ${mintShort}... skipped — in failed_swaps (24h cooldown)`);
        continue;
      }
      const { price: dexPrice, symbol: dexSymbol } = await fetchDexScreenerPrice(t.mint);
      let price = dexPrice;
      const symbol = dexSymbol ?? mintShort;
      let usdValue = price * t.uiAmount;
      console.log(`[autoSwap] ${mintShort}...: DexScreener price=$${price.toFixed(6)} | amount=${t.uiAmount} | value=$${usdValue.toFixed(4)}`);

      // Fallback: if DexScreener returns $0, try Jupiter quote to estimate value
      if (usdValue < AUTO_SWAP_MIN_USD) {
        console.log(`[autoSwap] ${mintShort}...: DexScreener gave $0 — trying Jupiter quote estimate...`);
        const jupEstimate = await estimateUsdViaJupiterQuote(t.mint, t.amount, t.uiAmount);
        if (jupEstimate > 0) {
          usdValue = jupEstimate;
          price = jupEstimate / t.uiAmount;
          console.log(`[autoSwap] ${mintShort}...: Jupiter estimate = $${usdValue.toFixed(4)}`);
        }
      }

      if (usdValue < AUTO_SWAP_MIN_USD) {
        console.log(`[autoSwap] Skip ${mintShort}...: estimated $${usdValue.toFixed(4)} < $${AUTO_SWAP_MIN_USD} min`);
      } else {
        swappable.push({ ...t, price, usdValue, symbol });
      }
    }

    if (swappable.length === 0) {
      console.log(`[autoSwap] No tokens above $${AUTO_SWAP_MIN_USD} threshold.`);
      return;
    }

    console.log(`[autoSwap] ${swappable.length} token(s) eligible for swap`);

    for (const token of swappable) {
      const mintShort = token.mint.slice(0, 8);
      // Cap at 3 attempts — rug/frozen tokens tend to fail identically at every
      // slippage; 4th tier (1000 bps) historically never rescues one.
      const SLIPPAGE_TIERS = [100, 300, 500];

      // Route check with partial-fallback: public.jupiterapi.com often lacks depth
      // for the full balance on thin tokens but can clear at /2, /4, /10.
      const fullAmount = parseInt(token.amount);
      const fractions = [1, 2, 4, 10];
      let swapAmount = token.amount;
      let hasRoute = false;
      let lastRouteErr = null;
      for (const frac of fractions) {
        const testAmount = String(Math.floor(fullAmount / frac));
        if (parseInt(testAmount) <= 0) break;
        try {
          await getJupiterQuote(token.mint, testAmount, 100);
          swapAmount = testAmount;
          hasRoute = true;
          if (frac > 1) console.log(`[AutoSwap] ${mintShort} full-size NO_ROUTES, amount/${frac} routes OK — partial swap`);
          break;
        } catch (err) {
          const noRoutes = err.message?.includes("NO_ROUTES_FOUND") || err.message?.includes("No routes found");
          lastRouteErr = err.message ?? null;
          if (!noRoutes) {
            // Non-route error (429/5xx/timeout) — bail without cooldown so we retry next cycle
            console.warn(`[AutoSwap] ${mintShort} route check error [${frac === 1 ? "full" : `amount/${frac}`}]: ${err.message?.slice(0, 80)}`);
            break;
          }
        }
      }
      if (!hasRoute) {
        const isNoRoutes = lastRouteErr?.includes("NO_ROUTES_FOUND") || lastRouteErr?.includes("No routes found");
        if (isNoRoutes) {
          const hours = NO_ROUTES_COOLDOWN_MS / 3_600_000;
          console.log(`[AutoSwap] ${mintShort} no route at full/2/4/10 → ${hours}h cooldown`);
          addFailedSwap({
            symbol: token.symbol,
            tokenMint: token.mint,
            amount: token.amount,
            reason: "NO_ROUTES_FOUND even at amount/10",
            cooldownMs: NO_ROUTES_COOLDOWN_MS,
          });
          await notifyTemp(`⚠️ Auto-swap skip: ${token.symbol ?? mintShort} — no Jupiter route (even at amount/10)\nBalance: ${token.uiAmount} (~$${token.usdValue.toFixed(2)}) — retry ${hours}h.`);
        }
        continue;
      }

      const swapAmountInt = parseInt(swapAmount);
      const partialRatio = swapAmountInt / fullAmount;
      const swapUiAmount = token.uiAmount * partialRatio;
      const swapUsdValue = token.usdValue * partialRatio;

      let swapped = false;
      let lastReason = null;
      for (const slippage of SLIPPAGE_TIERS) {
        try {
          console.log(`🔄 Swapping ${mintShort}... (${swapUiAmount}) ~$${swapUsdValue.toFixed(2)} [slippage=${slippage}bps${partialRatio < 1 ? `, ${(partialRatio * 100).toFixed(0)}%` : ""}]`);

          const quote = await getJupiterQuote(token.mint, swapAmount, slippage);
          const outLamports = parseInt(quote.outAmount ?? "0");
          const outSol = outLamports / 1e9;
          console.log(`[autoSwap] Quote: ${swapUiAmount} ${mintShort} → ${outSol.toFixed(6)} SOL`);

          const swapTxBase64 = await buildJupiterSwapTx(quote, wallet.publicKey.toString());
          const txBuf = Buffer.from(swapTxBase64, "base64");
          const tx = VersionedTransaction.deserialize(txBuf);
          tx.sign([wallet]);

          const latestBlockhash = await connection.getLatestBlockhash("confirmed");
          const sig = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
          });
          await connection.confirmTransaction({
            signature: sig,
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          }, "confirmed");

          const partialTag = partialRatio < 1 ? ` [${(partialRatio * 100).toFixed(0)}% partial]` : "";
          console.log(`✅ Swap success: ${mintShort} ($${swapUsdValue.toFixed(2)})${partialTag} → ${outSol.toFixed(4)} SOL | TX: https://solscan.io/tx/${sig}`);

          if (notifyFn) {
            await notifyFn(
              `🔄 <b>Auto-Swap${partialTag}</b>\n\n` +
              `Token: <code>${token.mint.slice(0, 8)}...</code>\n` +
              `Amount: ${swapUiAmount} (~$${swapUsdValue.toFixed(2)})\n` +
              `Received: <b>${outSol.toFixed(4)} SOL</b>\n\n` +
              `🔍 <a href="https://solscan.io/tx/${sig}">View TX ↗</a>`
            );
          }
          swapped = true;
          break;
        } catch (err) {
          lastReason = err.message?.slice(0, 200) ?? null;
          console.warn(`⚠️ Swap ${mintShort} failed [${slippage}bps]: ${err.message?.slice(0, 80)}`);
          if (slippage < SLIPPAGE_TIERS[SLIPPAGE_TIERS.length - 1]) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
      if (!swapped) {
        console.log(`[AutoSwap] ${token.symbol} failed after 3 attempts → skip`);
        addFailedSwap({ symbol: token.symbol, tokenMint: token.mint, amount: token.amount, reason: lastReason });
        // Clean up any legacy pending-swap entry so retryPendingSwaps stops picking it up.
        removePendingSwap(token.mint);
        await notifyTemp(`⚠️ Auto-swap gagal 3x: ${token.symbol} (~$${token.usdValue.toFixed(2)}) → skip 24h`);
      } else {
        removePendingSwap(token.mint);
      }
    }
  } catch (err) {
    console.error("[autoSwap] Fatal error:", err.message);
  }
}

export async function retryPendingSwaps(notifyFn = null) {
  const pending = loadPendingSwaps();
  if (pending.length === 0) return;

  const now = Date.now();
  const due = [];
  for (const swap of pending) {
    if (swap.nextRetryAt && now < swap.nextRetryAt) {
      const until = new Date(swap.nextRetryAt).toISOString();
      console.log(`[AutoSwap] Skip ${swap.tokenMint.slice(0, 8)}, cooldown until ${until}`);
      continue;
    }
    due.push(swap);
  }
  if (due.length === 0) return;
  console.log(`[PendingSwap] ${due.length} pending swap(s) to retry`);

  const dropped = new Set();

  for (const swap of due) {
    swap.retries = (swap.retries ?? 0) + 1;
    if (swap.retries > 5) {
      console.log(`[PendingSwap] ${swap.tokenMint.slice(0, 8)} exceeded 5 retries — removing`);
      removePendingSwap(swap.tokenMint);
      dropped.add(swap.tokenMint);
      continue;
    }

    if (swap.retries >= 3 && !swap.alertSent) {
      swap.nextRetryAt = now + FAIL_COOLDOWN_MS;
      swap.alertSent = true;
      const sym = swap.symbol ?? swap.tokenMint.slice(0, 8);
      const until = new Date(swap.nextRetryAt).toISOString();
      console.log(`[AutoSwap] ${sym} failed 3x, cooldown 24h until ${until}`);
      if (notifyFn) {
        try {
          await notifyFn(`⚠️ Auto-swap ${sym} gagal 3x — akan dicoba lagi besok. Swap manual jika urgent.`);
        } catch {}
      }
      continue;
    }

    try {
      console.log(`[PendingSwap] Retrying ${swap.tokenMint.slice(0, 8)}... (attempt ${swap.retries})`);
      await autoSwapTokensToSOL(notifyFn);
      break;
    } catch (err) {
      console.log(`[PendingSwap] Retry failed: ${err.message?.slice(0, 80)}`);
    }
  }

  const fresh = loadPendingSwaps();
  for (const swap of pending) {
    if (dropped.has(swap.tokenMint)) continue;
    const idx = fresh.findIndex(s => s.tokenMint === swap.tokenMint);
    if (idx >= 0) {
      fresh[idx].retries = swap.retries;
      if (swap.nextRetryAt !== undefined) fresh[idx].nextRetryAt = swap.nextRetryAt;
      if (swap.alertSent !== undefined) fresh[idx].alertSent = swap.alertSent;
    }
  }
  savePendingSwaps(fresh);
}
