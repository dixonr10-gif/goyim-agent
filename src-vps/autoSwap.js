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
  pending.push({ tokenMint, amount, usdValue, failedAt: new Date().toISOString(), retries: 0 });
  savePendingSwaps(pending);
}
function removePendingSwap(tokenMint) {
  const pending = loadPendingSwaps().filter(s => s.tokenMint !== tokenMint);
  savePendingSwaps(pending);
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
    return price;
  } catch {
    return 0;
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
      let price = await fetchDexScreenerPrice(t.mint);
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
        swappable.push({ ...t, price, usdValue });
      }
    }

    if (swappable.length === 0) {
      console.log(`[autoSwap] No tokens above $${AUTO_SWAP_MIN_USD} threshold.`);
      return;
    }

    console.log(`[autoSwap] ${swappable.length} token(s) eligible for swap`);

    for (const token of swappable) {
      const mintShort = token.mint.slice(0, 8);
      const SLIPPAGE_TIERS = [100, 300, 500, 1000];

      // Check for route existence first with a single quote
      let hasRoute = true;
      try {
        await getJupiterQuote(token.mint, token.amount, 100);
      } catch (err) {
        if (err.message?.includes("NO_ROUTES_FOUND") || err.message?.includes("No routes found")) {
          hasRoute = false;
          console.log(`[AutoSwap] ${mintShort} no route → manual swap needed`);
          await notifyTemp(`⚠️ Auto-swap gagal: ${mintShort} — No Jupiter route\nBalance: ${token.uiAmount} tokens (~$${token.usdValue.toFixed(2)})`);
        }
      }
      if (!hasRoute) continue;

      let swapped = false;
      for (const slippage of SLIPPAGE_TIERS) {
        try {
          console.log(`🔄 Swapping ${mintShort}... (${token.uiAmount}) ~$${token.usdValue.toFixed(2)} [slippage=${slippage}bps]`);

          const quote = await getJupiterQuote(token.mint, token.amount, slippage);
          const outLamports = parseInt(quote.outAmount ?? "0");
          const outSol = outLamports / 1e9;
          console.log(`[autoSwap] Quote: ${token.uiAmount} ${mintShort} → ${outSol.toFixed(6)} SOL`);

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

          console.log(`✅ Swap success: ${mintShort} ($${token.usdValue.toFixed(2)}) → ${outSol.toFixed(4)} SOL | TX: https://solscan.io/tx/${sig}`);

          if (notifyFn) {
            await notifyFn(
              `🔄 <b>Auto-Swap</b>\n\n` +
              `Token: <code>${token.mint.slice(0, 8)}...</code>\n` +
              `Amount: ${token.uiAmount} (~$${token.usdValue.toFixed(2)})\n` +
              `Received: <b>${outSol.toFixed(4)} SOL</b>\n\n` +
              `🔍 <a href="https://solscan.io/tx/${sig}">View TX ↗</a>`
            );
          }
          swapped = true;
          break;
        } catch (err) {
          console.warn(`⚠️ Swap ${mintShort} failed [${slippage}bps]: ${err.message?.slice(0, 80)}`);
          if (slippage < SLIPPAGE_TIERS[SLIPPAGE_TIERS.length - 1]) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
      if (!swapped) {
        console.log(`[AutoSwap] ${mintShort} failed all tiers → queued as pending`);
        addPendingSwap(token.mint, token.amount, token.usdValue);
        await notifyTemp(`⚠️ Swap pending: ${mintShort} belum ke-swap (~$${token.usdValue.toFixed(2)})\nAkan dicoba lagi di healer cycle berikutnya`);
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
  console.log(`[PendingSwap] ${pending.length} pending swap(s) to retry`);

  // Track mints that exceeded the retry budget this cycle so the trailing
  // patch step below doesn't accidentally resurrect them.
  const dropped = new Set();

  for (const swap of pending) {
    swap.retries = (swap.retries ?? 0) + 1;
    if (swap.retries > 5) {
      console.log(`[PendingSwap] ${swap.tokenMint.slice(0, 8)} exceeded 5 retries — removing`);
      removePendingSwap(swap.tokenMint);
      dropped.add(swap.tokenMint);
      continue;
    }
    try {
      console.log(`[PendingSwap] Retrying ${swap.tokenMint.slice(0, 8)}... (attempt ${swap.retries})`);
      // Trigger a full autoSwap which will pick up this token if balance > 0
      await autoSwapTokensToSOL(notifyFn);
      break; // autoSwap processes all tokens, so one call is enough
    } catch (err) {
      console.log(`[PendingSwap] Retry failed: ${err.message?.slice(0, 80)}`);
    }
  }

  // Persist incremented retry counters WITHOUT clobbering: re-read the file
  // fresh (so we capture the mid-loop removePendingSwap call AND any add/remove
  // done inside autoSwapTokensToSOL), then patch in the new retries count only
  // for entries that still exist. Without this, the previous trailing
  // savePendingSwaps(pending) would resurrect entries we just removed.
  const fresh = loadPendingSwaps();
  for (const swap of pending) {
    if (dropped.has(swap.tokenMint)) continue;
    const idx = fresh.findIndex(s => s.tokenMint === swap.tokenMint);
    if (idx >= 0) fresh[idx].retries = swap.retries;
  }
  savePendingSwaps(fresh);
}
