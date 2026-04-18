import { createRequire } from "module";
import { createRequire as cr2 } from "module";

// Patch bs58 untuk fix Non-base58 bug di DLMM SDK
const _req = cr2(import.meta.url);
try {
  const bs58mod = _req("bs58");
  const origDecode = bs58mod.decode?.bind(bs58mod) ?? bs58mod.default?.decode?.bind(bs58mod.default);
  const patchedDecode = (str) => {
    const s = typeof str === "string" ? str.trim() : str;
    return origDecode(s);
  };
  if (bs58mod.default) bs58mod.default.decode = patchedDecode;
  else bs58mod.decode = patchedDecode;
} catch(e) {}
import { config } from "../config.js";
import { checkTokenViability } from "./tokenChecker.js";

const require = createRequire(import.meta.url);
import fs from "fs";
import path from "path";
const POSITIONS_FILE = path.resolve("data/open_positions.json");
const GHOST_BL_FILE = path.resolve("data/ghost_blacklist.json");
const PENDING_REOPEN_FILE = path.resolve("data/pending_reopen.json");
const REOPEN_WAIT_MS = 5 * 60 * 1000; // OOR-right rebalance: wait 5min before re-entering

function loadPendingReopens() {
  try {
    if (fs.existsSync(PENDING_REOPEN_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_REOPEN_FILE, "utf-8"));
    }
  } catch (e) { console.warn("[PendingReopen] load error:", e.message); }
  return {};
}

function savePendingReopens(data) {
  try {
    fs.mkdirSync(path.dirname(PENDING_REOPEN_FILE), { recursive: true });
    fs.writeFileSync(PENDING_REOPEN_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error("[PendingReopen] save error:", e.message); }
}

const _ghostStrikes = {}; // { posId: { count, lastStrike } }

function loadGhostBlacklist() { try { return JSON.parse(fs.readFileSync(GHOST_BL_FILE, "utf-8")); } catch { return {}; } }
function saveGhostBlacklist(d) { try { fs.mkdirSync(path.dirname(GHOST_BL_FILE), { recursive: true }); fs.writeFileSync(GHOST_BL_FILE, JSON.stringify(d, null, 2)); } catch {} }

export function recordGhostStrike(positionId, reason) {
  const now = Date.now();
  const strike = _ghostStrikes[positionId] || { count: 0, lastStrike: 0 };
  if (now - strike.lastStrike < 300_000) return false; // 5 min cooldown between strikes
  strike.count++;
  strike.lastStrike = now;
  _ghostStrikes[positionId] = strike;
  console.log(`  [Ghost] Strike ${strike.count}/4 for ${positionId?.slice(0, 16)}`);

  if (strike.count >= 4) {
    const bl = loadGhostBlacklist();
    bl[positionId] = { reason, addedAt: new Date().toISOString(), strikes: strike.count };
    saveGhostBlacklist(bl);
    openPositions.delete(positionId);
    savePositions(openPositions);
    delete _ghostStrikes[positionId];
    console.log(`  [Ghost] ${positionId?.slice(0, 16)} BLACKLISTED after 4 strikes`);
    return true; // blacklisted
  }
  return false;
}

export function isGhostBlacklisted(positionAddress) {
  const bl = loadGhostBlacklist();
  return Object.values(bl).some(v => v.positionAddress === positionAddress) || !!bl[positionAddress];
}

export function getGhostBlacklist() { return loadGhostBlacklist(); }
export function clearGhostBlacklist() { saveGhostBlacklist({}); }

let _cachedSolPrice = 80;
let _solPriceCacheTime = 0;

async function fetchSolPriceUsd() {
  // Return cache if fresh (< 30s)
  if (Date.now() - _solPriceCacheTime < 30_000 && _cachedSolPrice > 10) return _cachedSolPrice;

  // Jupiter primary
  try {
    const res = await fetch("https://lite.jupiterapi.com/price?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(6000) });
    const d = await res.json();
    const p = d?.data?.So11111111111111111111111111111111111111112?.price;
    if (typeof p === "number" && p > 10) { _cachedSolPrice = p; _solPriceCacheTime = Date.now(); return p; }
  } catch {}
  // CoinGecko fallback
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(6000) });
    const d = await res.json();
    const p = d?.solana?.usd;
    if (typeof p === "number" && p > 10) { _cachedSolPrice = p; _solPriceCacheTime = Date.now(); return p; }
  } catch {}
  // Cache fallback — NEVER return 0
  console.log(`[Price] Using cached SOL price: $${_cachedSolPrice}`);
  return _cachedSolPrice;
}

function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8"));
      return new Map(Object.entries(data));
    }
  } catch {}
  return new Map();
}

function savePositions(map) {
  try {
    fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(Object.fromEntries(map), null, 2));
  } catch(e) { console.error("Save positions error:", e.message); }
}

const openPositions = loadPositions();
let _wallet = null;
let _walletAddress = null;

export async function getWallet() {
  if (_wallet) return _wallet;
  const { Keypair } = require("@solana/web3.js");
  
  const key = config.walletPrivateKey.trim();
  console.log("[WALLET] Key length:", key.length);
  
  // Decode base58 manual — tidak depend bs58 version
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = new Uint8Array(64);
  let result = BigInt(0);
  for (const char of key) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 char: ${char} (code ${char.charCodeAt(0)})`);
    result = result * 58n + BigInt(idx);
  }
  const hex = result.toString(16).padStart(128, "0");
  for (let i = 0; i < 64; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  
  _wallet = Keypair.fromSecretKey(bytes);
  _walletAddress = _wallet.publicKey.toString();
  console.log("[WALLET] Address:", _walletAddress);
  return _wallet;
}

export // ─── RPC fallback: flip to RPC_URL_FALLBACK for RPC_FALLBACK_WINDOW_MS after any 429.
// Helius's free tier chokes during bursty Healer/Hunter cycles; on 429 we sticky-switch
// to the secondary (defaults to api.mainnet-beta.solana.com) and auto-revert after the TTL.
let _useFallbackUntil = 0;
const RPC_FALLBACK_WINDOW_MS = 5 * 60 * 1000;

export function isRpcRateLimitError(err) {
  const msg = err?.message ?? "";
  return /429|rate[- ]?limit|too many requests/i.test(msg);
}

export function markRpcRateLimited(opName) {
  const wasActive = Date.now() < _useFallbackUntil;
  if (!wasActive) {
    console.log(`[RPC] 429 detected → switching to fallback RPC`);
    console.log(`[RPC] Fallback RPC used for ${opName}`);
  }
  _useFallbackUntil = Date.now() + RPC_FALLBACK_WINDOW_MS;
}

export function getConnection() {
  const { Connection } = require("@solana/web3.js");
  const fallbackActive = Date.now() < _useFallbackUntil && config.rpcUrlFallback;
  const url = fallbackActive ? config.rpcUrlFallback : config.rpcUrl;
  return new Connection(url, { commitment: "confirmed" });
}

// Wraps an RPC-touching op: on 429, sticky-switch to fallback and retry once.
export async function withRpcFallback(asyncFn, opName) {
  try {
    return await asyncFn();
  } catch (err) {
    if (isRpcRateLimitError(err) && config.rpcUrlFallback) {
      markRpcRateLimited(opName);
      return await asyncFn();
    }
    throw err;
  }
}

export async function initWallet() {
  const wallet = await getWallet();
  console.log(`🔴 Agent wallet: ${wallet.publicKey.toString()}`);
  return wallet.publicKey.toString();
}

export function getAgentWalletAddress() { return _walletAddress; }

export async function checkWalletBalance() {
  try {
    const wallet = await getWallet();
    const balance = await withRpcFallback(
      () => getConnection().getBalance(wallet.publicKey),
      "checkWalletBalance"
    );
    return balance / 1e9;
  } catch (err) {
    console.error("Balance check failed:", err.message);
    return null;
  }
}

export async function openPosition(decision) {
  const { targetPool, strategy, binRange, poolName } = decision;
  console.log("[OPEN] targetPool:", targetPool, "length:", targetPool?.length);
  if (!targetPool) throw new Error("No target pool");
  
  // Validasi pool address adalah base58 valid
  const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const invalidChars = [...targetPool].filter(c => !BASE58.includes(c));
  if (invalidChars.length > 0) throw new Error(`Invalid pool address chars: ${invalidChars.join(",")}`);
  if (targetPool.length < 32 || targetPool.length > 44) throw new Error(`Invalid pool address length: ${targetPool.length}`);

  const wallet = await getWallet();
  const connection = getConnection();
  const balance = await checkWalletBalance();

  if (balance !== null && balance < config.maxSolPerPosition + 0.01) {
    throw new Error(`SOL tidak cukup: ${balance?.toFixed(4)} SOL`);
  }

  console.log("🔍 Checking token viability before opening...");
  try {
    const DLMM = require("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;
    const { PublicKey, sendAndConfirmTransaction } = require("@solana/web3.js");
    const BN = require("bn.js");

    // Verify pool is valid DLMM before proceeding
    let dlmmPool;
    try {
      dlmmPool = await DLMMClass.create(connection, new PublicKey(targetPool));
      console.log(`  [PoolCheck] ${targetPool.slice(0,8)}... valid DLMM ✅`);
    } catch (poolErr) {
      if (poolErr.message?.includes("Invalid account discriminator")) {
        console.log(`  [PoolCheck] ${targetPool.slice(0,8)}... invalid DLMM ❌ — not a DLMM pool`);
        throw new Error(`Pool not DLMM: ${targetPool.slice(0,8)}`);
      }
      throw poolErr;
    }
    const tokenX = dlmmPool.tokenX?.publicKey?.toString();
    const tokenY = dlmmPool.tokenY?.publicKey?.toString();
    const WSOL = "So11111111111111111111111111111111111111112";

    console.log(`  Pool tokens: X=${tokenX?.slice(0,8)}... Y=${tokenY?.slice(0,8)}...`);

    const solIsX = tokenX === WSOL;
    const solIsY = tokenY === WSOL;
    if (!solIsX && !solIsY) throw new Error("Pool tidak ada SOL");

    const altToken = solIsX ? tokenY : tokenX;
    const altTokenSymbol = solIsX ? (dlmmPool.tokenY?.symbol ?? null) : (dlmmPool.tokenX?.symbol ?? null);
    const check = await checkTokenViability(targetPool, altToken);
    if (!check.viable) throw new Error(`Token tidak viable: ${check.warnings.join(", ")}`);

    console.log(`✅ Token check passed! Score: ${check.score}`);
    console.log(`📋 Opening ${strategy} on ${targetPool}`);

    const activeBin = await dlmmPool.getActiveBin();
    const binCount = (typeof binRange === "number" ? binRange : binRange?.upper) || 50;
    console.log(`  [Bins] using ${binCount} bins for ${strategy ?? "spot"} range`);

    let lowerBinId, upperBinId;
    if ((strategy ?? "spot").toLowerCase() === "bidask") {
      // BidAsk: 40% below + 60% above active bin — captures upside momentum
      // Active bin is included in range, so split (binCount - 1) to avoid exceeding MAX_BIN_ARRAY_SIZE (70)
      const binsBelow = Math.floor((binCount - 1) * 0.4);
      const binsAbove = binCount - 1 - binsBelow;
      lowerBinId = solIsY ? activeBin.binId - binsBelow : activeBin.binId - binsAbove;
      upperBinId = solIsY ? activeBin.binId + binsAbove : activeBin.binId + binsBelow;
      console.log(`  [Bins] BidAsk range: ${binsBelow} below + 1 active + ${binsAbove} above = ${binsBelow + 1 + binsAbove} total (max 70)`);
    } else {
      // Spot: 90% below + 10% above active bin (buffer to avoid instant OOR)
      const binsAbove = Math.floor(binCount * 0.1);
      const binsBelow = binCount - 1 - binsAbove; // -1 for active bin
      lowerBinId = solIsY ? activeBin.binId - binsBelow : activeBin.binId - binsAbove;
      upperBinId = solIsY ? activeBin.binId + binsAbove : activeBin.binId + binsBelow;
      console.log(`  [Bins] Spot range: ${binsBelow} below + 1 active + ${binsAbove} above = ${binsBelow + 1 + binsAbove} total`);
    }
    const solLamports = Math.floor(config.maxSolPerPosition * 1e9);

    const positionKeypair = require("@solana/web3.js").Keypair.generate();

    const STRATEGY_MAP = { spot: 0, curve: 1, bidask: 2 };
    const strategyType = STRATEGY_MAP[strategy?.toLowerCase()] ?? 0;
    console.log(`  📐 Strategy: ${strategy ?? "spot"} → strategyType=${strategyType}`);

    // Retry on ExceededBinSlippageTolerance (AnchorError 6004): the active bin can
    // shift between quote and execution. Start at 1%, jump to 4% on a single
    // bin-slippage failure — 2% wasn't enough for pumping memes with 1%-bin steps.
    let sig;
    let slippage = 1;
    const MAX_SLIPPAGE_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_SLIPPAGE_ATTEMPTS; attempt++) {
      try {
        const tx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
          positionPubKey: positionKeypair.publicKey,
          user: wallet.publicKey,
          totalXAmount: new BN(solIsX ? solLamports : 0),
          totalYAmount: new BN(solIsY ? solLamports : 0),
          strategy: {
            maxBinId: upperBinId,
            minBinId: lowerBinId,
            strategyType,
          },
          slippage,
        });
        sig = await sendAndConfirmTransaction(connection, tx, [wallet, positionKeypair]);
        break;
      } catch (err) {
        // Solana RPC errors stuff the 6004 code into err.logs (array) and
        // err.simulationResponse — not err.message. Check all three.
        const msgParts = [
          err?.message,
          ...(err?.logs ?? []),
          JSON.stringify(err?.simulationResponse ?? {}),
        ].join("\n");
        const isBinSlippage = /6004|ExceededBinSlippageTolerance/i.test(msgParts);
        if (isBinSlippage && attempt < MAX_SLIPPAGE_ATTEMPTS) {
          slippage = 4;
          console.log(`[Position] Retry with higher slippage tolerance (${slippage}%)`);
          continue;
        }
        throw err;
      }
    }
    console.log(`✅ TX: https://solscan.io/tx/${sig}`);

    // Fetch SOL price at entry for USD-based PnL calculation
    let solPriceAtEntry = 0;
    try {
      const priceRes = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { signal: AbortSignal.timeout(8000) }
      );
      const priceData = await priceRes.json();
      const p = priceData?.solana?.usd;
      if (typeof p === "number" && p > 10) solPriceAtEntry = p;
      console.log(`[OPEN] SOL price at entry: $${solPriceAtEntry}`);
    } catch (e) { console.warn("[OPEN] Could not fetch SOL price at entry:", e.message); }

    const positionId = "pos_" + Date.now();
    openPositions.set(positionId, {
      id: positionId,
      pool: targetPool,
      poolName: poolName ?? null,
      strategy: strategy ?? "spot",
      binRange: { lower: lowerBinId, upper: upperBinId, active: activeBin.binId, strategy: strategy ?? "spot" },
      openedAt: new Date().toISOString(),
      solDeployed: config.maxSolPerPosition,
      solPriceAtEntry,
      tokenMint: altToken,
      tokenSymbol: altTokenSymbol,
      walletAddress: wallet.publicKey.toString(),
      positionAddress: positionKeypair.publicKey.toString(),
      txSignature: sig,
      tokenCheck: check,
    });

    if (openPositions.size > 0) savePositions(openPositions);
    console.log(`✅ Real position opened: ${positionId}`);

    return positionId;

  } catch (err) {
    console.log(`[Open] failed: ${err.message}`);
    throw err; // propagate — never create mock positions
  }
}

export async function closePosition(positionId, closeMeta = {}) {
  const pos = openPositions.get(positionId);
  if (!pos) {
    console.log(`[Close] ${positionId} not in local state — already removed`);
    return { success: true, txSignatures: [], solReceived: 0, externalClose: true };
  }

  if (pos.mock) {
    openPositions.delete(positionId);
    if (openPositions.size > 0) savePositions(openPositions);
    console.log(`Mock position closed: ${positionId}`);
    return true;
  }

  try {
    const DLMM = require('@meteora-ag/dlmm');
    const DLMMClass = DLMM.default ?? DLMM;
    const { PublicKey, sendAndConfirmTransaction } = require('@solana/web3.js');
    const BN = require('bn.js');
    const wallet = await getWallet();
    const connection = getConnection();

    if (!pos.positionAddress) throw new Error(`No positionAddress for ${positionId} — cannot close`);

    // Helper: set cooldown for closed token using the provided reason+pnl so
    // cooldownManager can pick the right per-reason duration.
    const _setCooldownForPos = async (p) => {
      try {
        const { extractTokenSymbol, setCooldown } = await import("./cooldownManager.js");
        const symbol = extractTokenSymbol(p.poolName);
        if (symbol) setCooldown(symbol, { reason: closeMeta.reason ?? null, pnlPct: closeMeta.pnlPct ?? null });
      } catch {}
    };

    // Check if position already closed on-chain before attempting TX.
    // Wrap in withRpcFallback: a 429 here cascades into the whole close-retry loop.
    const preCheck = await withRpcFallback(
      () => getConnection().getAccountInfo(new PublicKey(pos.positionAddress)),
      "closePosition.preCheck"
    );
    if (preCheck === null) {
      console.log(`⚠️ Position ${pos.positionAddress.slice(0,8)} already gone on-chain — cleaning up local state`);
      await _setCooldownForPos(pos);
      openPositions.delete(positionId);
      savePositions(openPositions);
      return { success: true, txSignatures: [], solReceived: pos.solDeployed, externalClose: true };
    }

    const dlmmPool = await DLMMClass.create(connection, new PublicKey(pos.pool));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    // Only match by exact positionAddress — never fall back to userPositions[0]
    const positionData = userPositions.find(p => p.publicKey.toString() === pos.positionAddress);
    if (!positionData) {
      console.log(`⚠️ Position ${pos.positionAddress.slice(0,8)} not in SDK (${userPositions.length} in pool) — already closed externally, cleaning up`);
      await _setCooldownForPos(pos);
      openPositions.delete(positionId);
      savePositions(openPositions);
      return { success: true, txSignatures: [], solReceived: pos.solDeployed, externalClose: true };
    }

    // Capture SOL balance before close TXs to compute actual solReceived
    const preBalance = await connection.getBalance(wallet.publicKey);

    const MAX_ATTEMPTS = 3;
    let lastErr = null;
    const txSignatures = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`🔄 Close TX retry ${attempt}/${MAX_ATTEMPTS}...`);
          await new Promise(r => setTimeout(r, 3000 * attempt));
        }

        // removeLiquidity with fromBinId/toBinId range (SDK v1.9.4+ API)
        let txArray = [];
        const binIds = positionData.positionData.positionBinData.map(b => b.binId).filter(Number.isFinite);
        const fromBinId = Math.min(...binIds);
        const toBinId = Math.max(...binIds);
        console.log(`  removeLiquidity range: [${fromBinId}, ${toBinId}] across ${binIds.length} bins`);
        const removeTx = await dlmmPool.removeLiquidity({
          position: new PublicKey(pos.positionAddress),
          user: wallet.publicKey,
          fromBinId,
          toBinId,
          bps: new BN(10000),
          shouldClaimAndClose: true,
        });
        txArray = Array.isArray(removeTx) ? removeTx : (removeTx ? [removeTx] : []);
        console.log(`  removeLiquidity returned ${txArray.length} TX(s)`);

        if (txArray.length === 0) {
          console.warn(`  removeLiquidity returned 0 TXs — attempting closePosition (position may be empty)`);
          const closeTx = await dlmmPool.closePosition({
            owner: wallet.publicKey,
            position: positionData,
          });
          txArray = Array.isArray(closeTx) ? closeTx : (closeTx ? [closeTx] : []);
          console.log(`  closePosition returned ${txArray.length} TX(s)`);
        }

        for (const tx of txArray) {
          const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
            commitment: 'confirmed',
            skipPreflight: false,
          });
          txSignatures.push(sig);
          console.log(`✅ Close TX: https://solscan.io/tx/${sig}`);
        }
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        // If this failure was 429, flip to fallback RPC for subsequent retries.
        if (isRpcRateLimitError(err)) markRpcRateLimited("closePosition");
        console.warn(`⚠️ Close attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      }
    }
    if (lastErr) throw lastErr;

    // Measure actual SOL returned — balance delta after all close TXs confirmed
    let solReceived = pos.solDeployed; // fallback
    try {
      const postBalance = await connection.getBalance(wallet.publicKey);
      const delta = (postBalance - preBalance) / 1e9;
      if (delta > 0) solReceived = delta;
      console.log(`  💰 SOL balance delta after close: ${delta >= 0 ? "+" : ""}${delta.toFixed(4)} SOL → solReceived=${solReceived.toFixed(4)}`);
    } catch {}

    // ── Verify closure via DLMM SDK (not raw account — position accounts can linger empty)
    await new Promise(r => setTimeout(r, 4000));
    const { userPositions: postPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey).catch(() => ({ userPositions: null }));
    if (postPositions !== null) {
      const stillOpen = postPositions.find(p => p.publicKey.toString() === pos.positionAddress);
      if (stillOpen) {
        const remainingBins = stillOpen.positionData?.positionBinData?.filter(
          b => (parseFloat(b.positionXAmount ?? b.amountX ?? 0) + parseFloat(b.positionYAmount ?? b.amountY ?? 0)) > 0
        ) ?? [];
        if (remainingBins.length > 0) {
          throw new Error(`TX confirmed but position ${pos.positionAddress.slice(0,8)} still has liquidity in ${remainingBins.length} bins — NOT removing from local state`);
        }
        // Position exists but all bins empty — safely closed, account just not reclaimed yet
        console.log(`  ℹ️ Position account still exists but all bins empty — treated as closed`);
      }
    }

    // Set cooldown using the reason+pnl the caller passed in.
    await _setCooldownForPos(pos);

    openPositions.delete(positionId);
    savePositions(openPositions);
    console.log(`✅ Position ${positionId} confirmed closed on-chain`);
    return { success: true, txSignatures, solReceived };
  } catch (err) {
    console.error('❌ Close TX failed:', err.message);
    throw err;
  }
}
export function getOpenPositions() {
  return Array.from(openPositions.values());
}







export async function syncOnChainPositions() {
  try {
    // Repair positions with missing solPriceAtEntry
    let repaired = false;
    for (const [, pos] of openPositions.entries()) {
      if (!pos.solPriceAtEntry || pos.solPriceAtEntry === 0) {
        pos.solPriceAtEntry = await fetchSolPriceUsd();
        repaired = true;
        console.log(`  [Sync] Repaired solPriceAtEntry for ${pos.id}: $${pos.solPriceAtEntry}`);
      }
    }
    if (repaired) savePositions(openPositions);

    const { createRequire } = await import("module");
    const cr = createRequire(import.meta.url);
    const DLMM = cr("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;
    const { Connection, PublicKey } = cr("@solana/web3.js");
    const connection = new Connection(config.rpcUrl, { commitment: "confirmed" });
    const wallet = await getWallet();

    console.log("🔄 Syncing positions from on-chain...");
    const allPositions = await DLMMClass.getAllLbPairPositionsByUser(
      connection,
      wallet.publicKey
    );

    // SDK returns Map<string, PositionInfo> — handle both Map and plain object
    const entries = allPositions instanceof Map
      ? [...allPositions.entries()]
      : Object.entries(allPositions ?? {});

    console.log(`[SYNC] Found ${entries.length} LB pair(s) on-chain`);

    for (const [lbPair, positionData] of entries) {
      for (const pos of positionData.lbPairPositionsData ?? []) {
        const posAddress = pos.publicKey?.toString();
        if (!posAddress) continue;
        // Cek apakah sudah ada di memory lokal (untuk preserve metadata)
        const existing = Array.from(openPositions.values()).find(
          p => p.positionAddress === posAddress
        );
        if (!existing) {
          // Skip ghost-blacklisted positions
          const gbl = loadGhostBlacklist();
          if (gbl[posAddress]) { console.log(`  [Sync] Skipping blacklisted ghost: ${posAddress.slice(0,8)}`); continue; }

          const binData = pos.positionData?.positionBinData ?? [];
          const binIds = binData.map(b => b.binId).filter(Number.isFinite);
          const binRange = binIds.length > 0
            ? { lower: Math.min(...binIds), upper: Math.max(...binIds) }
            : undefined;
          // Fetch current SOL price for synced positions
          let solPriceAtEntry = await fetchSolPriceUsd();
          // Resolve pool name from Meteora API so blacklist tracking works
          let poolName = null;
          try {
            const pairRes = await fetch(`https://dlmm.datapi.meteora.ag/pair/${lbPair}`, { signal: AbortSignal.timeout(8000) });
            if (pairRes.ok) { const pd = await pairRes.json(); poolName = pd.name ?? null; }
          } catch {}
          if (!poolName) {
            try {
              const dxRes = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${lbPair}`, { signal: AbortSignal.timeout(8000) });
              const dxData = await dxRes.json();
              const pair = dxData?.pair ?? dxData?.pairs?.[0];
              if (pair) poolName = `${pair.baseToken?.symbol ?? "?"}-${pair.quoteToken?.symbol ?? "?"}`;
            } catch {}
          }
          const syncedPos = {
            id: posAddress,
            pool: lbPair,
            poolName,
            positionAddress: posAddress,
            strategy: "spot",
            solDeployed: config.maxSolPerPosition,
            solPriceAtEntry,
            openedAt: new Date().toISOString(),
            binRange,
            syncedFromChain: true,
          };
          openPositions.set(posAddress, syncedPos);
          console.log(`📡 Found on-chain position: ${posAddress.slice(0,8)}... pool: ${lbPair.slice(0,8)}... name: ${poolName ?? "unknown"}`);
          // Record to trade memory so close can find it
          try {
            const { recordTradeOpen } = await import("./tradeMemory.js");
            recordTradeOpen({ positionId: posAddress, pool: lbPair, poolName, strategy: "spot", solDeployed: config.maxSolPerPosition, decision: { confidence: null, rationale: "synced from chain" } });
          } catch {}
        }
      }
    }

    // ── Remove ghost positions (local but not on-chain) ─────────────────────
    const onChainAddresses = new Set();
    for (const [, positionData] of entries) {
      for (const pos of positionData.lbPairPositionsData ?? []) {
        if (pos.publicKey?.toString()) onChainAddresses.add(pos.publicKey.toString());
      }
    }

    const manuallyClosedPositions = [];
    for (const [id, pos] of openPositions.entries()) {
      if (!pos.positionAddress) continue;
      if (!onChainAddresses.has(pos.positionAddress)) {
        try {
          const { PublicKey: PK } = cr("@solana/web3.js");
          const accountInfo = await connection.getAccountInfo(new PK(pos.positionAddress));
          if (accountInfo === null) {
            manuallyClosedPositions.push({ ...pos });
            openPositions.delete(id);
            console.log(`[Sync] ${id} (${pos.positionAddress.slice(0,8)}...) not on-chain → manual close detected`);
          }
        } catch {}
      }
    }

    if (openPositions.size > 0 || manuallyClosedPositions.length > 0) savePositions(openPositions);
    console.log(`✅ On-chain sync done: ${openPositions.size} positions found${manuallyClosedPositions.length ? ` | ${manuallyClosedPositions.length} manual close(s)` : ""}`);
    return { count: openPositions.size, manuallyClosedPositions };
  } catch (err) {
    console.error("⚠️ On-chain sync failed:", err.message);
    return openPositions.size;
  }
}

export async function getPositionValue(position) {
  try {
    const { createRequire } = await import("module");
    const cr = createRequire(import.meta.url);
    const DLMM = cr("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;
    const { Connection, PublicKey } = cr("@solana/web3.js");
    const connection = new Connection(config.rpcUrl, { commitment: "confirmed" });
    const wallet = await getWallet();

    const dlmmPool = await DLMMClass.create(connection, new PublicKey(position.pool));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    let posData = userPositions.find(p => p.publicKey.toString() === position.positionAddress);

    if (!posData) {
      console.log(`[PNL] ${position.positionAddress?.slice(0,8)} not in pool (${userPositions.length} positions)`);
      recordGhostStrike(position.id, `not in pool (${userPositions.length} positions)`);
      position._posValueUsd = 0;
      position._solPriceNow = 0;
      position._positionGone = true;
      return 0;
    }

    const WSOL = "So11111111111111111111111111111111111111112";
    const tokenXMint = dlmmPool.tokenX?.publicKey?.toString();
    const tokenYMint = dlmmPool.tokenY?.publicKey?.toString();
    const xIsSol = tokenXMint === WSOL;
    const altTokenMint = xIsSol ? tokenYMint : tokenXMint;

    // Get ACTUAL decimals from on-chain mint (DLMM SDK often returns undefined → default 9 is wrong)
    let decimalsX = dlmmPool.tokenX?.decimal ?? dlmmPool.tokenX?.decimals ?? null;
    let decimalsY = dlmmPool.tokenY?.decimal ?? dlmmPool.tokenY?.decimals ?? null;
    if (decimalsX === null || decimalsY === null) {
      try {
        const { PublicKey: PK } = cr("@solana/web3.js");
        if (decimalsX === null && tokenXMint) {
          const mintInfo = await connection.getParsedAccountInfo(new PK(tokenXMint));
          decimalsX = mintInfo?.value?.data?.parsed?.info?.decimals ?? 9;
        }
        if (decimalsY === null && tokenYMint) {
          const mintInfo = await connection.getParsedAccountInfo(new PK(tokenYMint));
          decimalsY = mintInfo?.value?.data?.parsed?.info?.decimals ?? 9;
        }
      } catch (e) { console.warn("[PNL] mint decimals fetch error:", e.message); }
    }
    decimalsX = decimalsX ?? 9;
    decimalsY = decimalsY ?? 9;

    const bins = posData.positionData?.positionBinData ?? [];
    console.log(`[PNL] bins: ${bins.length} | X=${tokenXMint?.slice(0,8)} dec=${decimalsX} | Y=${tokenYMint?.slice(0,8)} dec=${decimalsY}`);

    const activeBin = await dlmmPool.getActiveBin();
    const pricePerToken = parseFloat(activeBin.pricePerToken ?? activeBin.price ?? 0);

    let totalX = 0, totalY = 0, feeX = 0, feeY = 0;
    for (const bin of bins) {
      totalX += parseFloat(bin.positionXAmount ?? bin.amountX ?? 0) / (10 ** decimalsX);
      totalY += parseFloat(bin.positionYAmount ?? bin.amountY ?? 0) / (10 ** decimalsY);
      feeX += parseFloat(bin.positionFeeXAmount ?? 0) / (10 ** decimalsX);
      feeY += parseFloat(bin.positionFeeYAmount ?? 0) / (10 ** decimalsY);
    }

    // Fetch SOL price USD (Jupiter primary, CoinGecko fallback)
    let solPriceUsd = await fetchSolPriceUsd();

    // Token price: primary = pool's own pricePerToken * SOL price (always available)
    const tokenPriceInSol = pricePerToken;
    let tokenPriceUsd = tokenPriceInSol * solPriceUsd;

    // Cross-check with DexScreener if available
    const hasToken = (xIsSol ? totalY + feeY : totalX + feeX) > 0;
    if (altTokenMint && hasToken) {
      try {
        const tRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${altTokenMint}`, { signal: AbortSignal.timeout(6000) });
        const tData = await tRes.json();
        const pairs = (tData?.pairs ?? []).filter(p => parseFloat(p.priceUsd ?? "0") > 0);
        pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        const bestPair = pairs.find(p => p.baseToken?.address === altTokenMint);
        if (bestPair) {
          const dexPrice = parseFloat(bestPair.priceUsd);
          if (dexPrice > 0) {
            console.log(`[PNL] tokenPrice: pool=$${tokenPriceUsd.toFixed(8)} dex=$${dexPrice.toFixed(8)}`);
            tokenPriceUsd = dexPrice; // prefer DexScreener when available
          }
        }
      } catch {}
    }

    // Separate liquidity and unclaimed fees for clear logging
    const liqSol = xIsSol ? totalX : totalY;
    const liqToken = xIsSol ? totalY : totalX;
    const unclaimedFeeSol = xIsSol ? feeX : feeY;
    const unclaimedFeeToken = xIsSol ? feeY : feeX;

    const solAmount = liqSol + unclaimedFeeSol;
    const tokenAmount = liqToken + unclaimedFeeToken;

    const solValueUsd = solAmount * solPriceUsd;
    const tokenValueUsd = tokenAmount * tokenPriceUsd;
    const positionUsd = solValueUsd + tokenValueUsd;

    // Add previously claimed fees (tracked by feeCompounder)
    const claimedFeesUsd = position.claimedFeesUsd ?? 0;
    const totalUsd = positionUsd + claimedFeesUsd;

    const unclaimedFeesUsd = (unclaimedFeeSol * solPriceUsd) + (unclaimedFeeToken * tokenPriceUsd);
    const totalSolEquiv = solPriceUsd > 0 ? totalUsd / solPriceUsd : solAmount;

    // Use || not ?? so 0 falls back to current SOL price
    const entryPrice = position.solPriceAtEntry || solPriceUsd;
    if (!position.solPriceAtEntry || position.solPriceAtEntry === 0) {
      position.solPriceAtEntry = solPriceUsd; // repair inline
    }
    const entryUsd = position.solDeployed * entryPrice;
    const pnlPct = entryUsd > 0 ? ((totalUsd - entryUsd) / entryUsd * 100) : 0;

    console.log(`[PNL] bins: ${bins.length} | SOL: ${solAmount.toFixed(4)} ($${solValueUsd.toFixed(2)}) | Token: ${tokenAmount.toFixed(2)} ($${tokenValueUsd.toFixed(2)}) @ $${tokenPriceUsd.toFixed(6)}`);
    console.log(`[PNL] position=$${positionUsd.toFixed(2)} + unclaimedFees=$${unclaimedFeesUsd.toFixed(2)} + claimedFees=$${claimedFeesUsd.toFixed(2)} = total=$${totalUsd.toFixed(2)} | entry=$${entryUsd.toFixed(2)} → ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`);

    // Sanity check: if totalUsd is 0 or near-0 but position has bins with amounts, data is bad
    if (totalUsd < 1 && (solAmount > 0.01 || tokenAmount > 0)) {
      console.log(`[PNL] Sanity fail: totalUsd=$${totalUsd.toFixed(2)} but SOL=${solAmount.toFixed(4)} token=${tokenAmount.toFixed(0)} — marking as bad data`);
      position._posValueUsd = 0;
      position._solPriceNow = 0;
      position._badData = true;
      return 0;
    }

    // Store detailed breakdown on position for use by exitStrategy
    position._posValueUsd = totalUsd;
    position._solPriceNow = solPriceUsd;
    position._badData = false;

    return totalSolEquiv > 0 ? totalSolEquiv : position.solDeployed;
  } catch (err) {
    console.error("[PNL ERROR]", err.message);
    return position.solDeployed;
  }
}

export async function getPositionBinStatus(positionId) {
  const pos = openPositions.get(positionId);
  if (!pos) return null;
  try {
    const DLMM = require("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;
    const { PublicKey } = require("@solana/web3.js");
    const wallet = await getWallet();
    const connection = getConnection();
    const dlmmPool = await DLMMClass.create(connection, new PublicKey(pos.pool));
    const activeBin = await dlmmPool.getActiveBin();
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    let posData = userPositions.find(p => p.publicKey.toString() === pos.positionAddress);
    if (!posData) return { outOfRange: false, activeBinId: activeBin.binId, totalFeeSol: 0 };
    const binIds = (posData.positionData?.positionBinData ?? []).map(b => b.binId).filter(id => id !== undefined);
    if (binIds.length === 0) return { outOfRange: false, activeBinId: activeBin.binId, totalFeeSol: 0 };
    const lowerBin = Math.min(...binIds);
    const upperBin = Math.max(...binIds);
    const activeBinId = activeBin.binId;
    const outOfRange = activeBinId < lowerBin || activeBinId > upperBin;

    // Calculate claimable fees in SOL equivalent
    const WSOL = "So11111111111111111111111111111111111111112";
    const tokenXMint = dlmmPool.tokenX?.publicKey?.toString();
    const xIsSol = tokenXMint === WSOL;
    const decX = dlmmPool.tokenX?.decimal ?? dlmmPool.tokenX?.decimals ?? 9;
    const decY = dlmmPool.tokenY?.decimal ?? dlmmPool.tokenY?.decimals ?? 9;
    const price = parseFloat(activeBin.pricePerToken ?? activeBin.price ?? 0);

    let totalFeeSol = 0;
    for (const bin of posData.positionData?.positionBinData ?? []) {
      const fX = parseFloat(bin.positionFeeXAmount ?? 0) / (10 ** decX);
      const fY = parseFloat(bin.positionFeeYAmount ?? 0) / (10 ** decY);
      // Convert everything to SOL equivalent
      if (xIsSol) {
        totalFeeSol += fX + (price > 0 ? fY * price : 0);
      } else {
        totalFeeSol += fY + (price > 0 ? fX * price : 0);
      }
    }
    // Include previously claimed fees (converted to SOL)
    if (pos.claimedFeesUsd > 0) {
      try {
        const pr = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(5000) });
        const solPrice = (await pr.json())?.solana?.usd ?? 0;
        if (solPrice > 0) totalFeeSol += pos.claimedFeesUsd / solPrice;
      } catch {}
    }

    // OOR direction: right = token pump (all-token), left = token dump (all-SOL)
    const oorDirection = !outOfRange ? null : activeBinId > upperBin ? "right" : "left";

    return { outOfRange, activeBinId, lowerBin, upperBin, totalFeeSol, oorDirection };
  } catch (err) {
    console.log(`[OOR] bin status check failed for ${positionId}: ${err.message}`);
    return null;
  }
}

/** Update a single field on a tracked position (persists to disk) */
export function updatePositionField(positionId, field, value) {
  const pos = openPositions.get(positionId);
  if (!pos) return;
  if (value === null || value === undefined) {
    delete pos[field];
  } else {
    pos[field] = value;
  }
  savePositions(openPositions);
}

export async function rebalancePosition(positionId) {
  const pos = openPositions.get(positionId);
  if (!pos) throw new Error(`Position ${positionId} not found for rebalance`);
  // Save pos data before close deletes it
  const posData = { ...pos };
  console.log(`🔄 Rebalancing ${positionId} (pool: ${pos.pool?.slice(0, 8)}...)...`);
  const closeResult = await closePosition(positionId, { reason: "REBALANCE" });
  // Use actual SOL received from close as the new deposit amount
  const solReceived = closeResult?.solReceived ?? posData.solDeployed ?? config.maxSolPerPosition;
  console.log(`  [Rebalance] solReceived=${solReceived.toFixed?.(4) ?? solReceived} → queuing re-open after 5min`);

  // Record the closed trade + notify Telegram (was missing — caused ghost closes)
  try {
    const { recordTradeClose } = await import("./tradeMemory.js");
    recordTradeClose({ positionId, solReturned: solReceived, poolName: posData.poolName, solDeployed: posData.solDeployed, closeReason: "REBALANCE" });
  } catch (e) { console.warn(`  [Rebalance] recordTradeClose failed: ${e.message}`); }
  try {
    const { notifyPositionClosed } = await import("./telegramBot.js");
    await notifyPositionClosed(positionId, "rebalance: out of range (re-opening in 5min)", closeResult?.txSignatures ?? []);
  } catch (e) { console.warn(`  [Rebalance] notifyPositionClosed failed: ${e.message}`); }

  // Persist re-open intent so the wait survives PM2 restarts. The healer cycle
  // calls processPendingReopens() each tick and fires the open once REOPEN_WAIT_MS
  // has elapsed since `savedAt`. Replaces an in-memory setTimeout that was lost
  // whenever PM2 restarted mid-wait, leaving an orphaned close with no re-entry.
  const pending = loadPendingReopens();
  pending[positionId] = {
    oldPositionId: positionId,
    pool: posData.pool,
    poolName: posData.poolName,
    strategy: posData.strategy ?? "spot",
    solReceived,
    rebalanceCount: posData.rebalanceCount ?? 0,
    savedAt: Date.now(),
  };
  savePendingReopens(pending);
  console.log(`  [Rebalance] OOR-right: re-open queued (5min, restart-safe)`);

  // Auto-swap token sisa ke SOL. OOR-right close returns all-token (pump exit),
  // tokens would otherwise sit idle in wallet until re-open fires.
  try {
    console.log(`[AutoSwap] Triggered after REBALANCE close`);
    await new Promise(r => setTimeout(r, 20000));
    const { autoSwapTokensToSOL } = await import("./autoSwap.js");
    const { notifyMessage } = await import("./telegramBot.js");
    await autoSwapTokensToSOL(notifyMessage);
  } catch (e) { console.warn(`  [Rebalance] autoSwap failed: ${e.message}`); }

  return true; // signal to caller: rebalance scheduled, skip plain close
}

/**
 * Drain data/pending_reopen.json: any entry whose 5-min wait has elapsed gets
 * re-opened, then removed. Called from healer cycle each tick. Restart-safe —
 * if the agent crashes/restarts during the wait, the queue file persists.
 */
export async function processPendingReopens() {
  const pending = loadPendingReopens();
  const entries = Object.entries(pending);
  if (entries.length === 0) return;

  const now = Date.now();
  for (const [key, entry] of entries) {
    const ageMs = now - (entry.savedAt ?? 0);
    if (ageMs < REOPEN_WAIT_MS) {
      const remainingS = Math.ceil((REOPEN_WAIT_MS - ageMs) / 1000);
      console.log(`  [PendingReopen] ${entry.poolName ?? entry.pool?.slice(0,8)}: ${remainingS}s remaining`);
      continue;
    }

    // Skip re-open during strict hours — keep entry in queue for next cycle
    try {
      const { isStrictHours } = await import("./timeHelper.js");
      if (isStrictHours()) {
        console.log(`  [PendingReopen] Skip ${entry.poolName ?? entry.pool?.slice(0,8)}: strict hours — retry later`);
        continue;
      }
    } catch {}

    // Wait elapsed — remove entry FIRST so a concurrent healer tick can't
    // double-trigger, then attempt the re-open. On failure we DO NOT re-add
    // the entry (would loop forever); we notify and let the user intervene.
    const fresh = loadPendingReopens();
    delete fresh[key];
    savePendingReopens(fresh);

    console.log(`  [PendingReopen] firing re-open for ${entry.poolName ?? entry.pool?.slice(0,8)} (waited ${(ageMs/60000).toFixed(1)}min)`);

    const origMax = config.maxSolPerPosition;
    config.maxSolPerPosition = entry.solReceived;
    try {
      const newPosId = await openPosition({
        targetPool: entry.pool,
        poolName: entry.poolName,
        strategy: entry.strategy ?? "spot",
        binRange: { upper: 50 },
        confidence: 70,
        rationale: "auto-rebalance after OOR (deferred re-open)",
      });
      // Carry rebalance lineage onto the new position
      const newPos = openPositions.get(newPosId);
      if (newPos) {
        newPos.rebalanceCount = (entry.rebalanceCount ?? 0) + 1;
        newPos.rebalancedFrom = entry.oldPositionId;
        savePositions(openPositions);
      }
      // Create trade memory record so recordTradeClose doesn't fall into its
      // "missing record" branch (which stamps poolName="unknown" and corrupts
      // per-token blacklist loss tracking). Mirrors Hunter's open flow.
      try {
        const { recordTradeOpen } = await import("./tradeMemory.js");
        recordTradeOpen({
          positionId: newPosId,
          pool: entry.pool,
          poolName: entry.poolName,
          strategy: entry.strategy ?? "spot",
          solDeployed: entry.solReceived,
          decision: { confidence: 70, rationale: "auto-rebalance after OOR (deferred re-open)" },
        });
      } catch (e) { console.warn(`  [PendingReopen] recordTradeOpen failed: ${e.message}`); }
      console.log(`  ✅ [PendingReopen] re-opened ${entry.oldPositionId} → ${newPosId}`);
      try {
        const { notifyMessage } = await import("./telegramBot.js");
        await notifyMessage(`🔁 Rebalance re-open\nPool: ${entry.poolName ?? entry.pool?.slice(0,8)}\nNew pos: ${newPosId}`);
      } catch {}
    } catch (err) {
      console.warn(`  ❌ [PendingReopen] re-open failed for ${entry.oldPositionId}: ${err.message}`);
      try {
        const { notifyError } = await import("./telegramBot.js");
        await notifyError(`[PendingReopen] re-open failed for ${entry.poolName ?? entry.pool?.slice(0,8)}: ${err.message?.slice(0, 200)}`);
      } catch {}
    } finally {
      config.maxSolPerPosition = origMax;
    }
  }
}

export async function checkOutOfRange(positionId) {
  const pos = openPositions.get(positionId);
  if (!pos || pos.mock || !pos.positionAddress) {
    return { outOfRange: false, reason: "no position data" };
  }
  try {
    const DLMM = require("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;
    const { PublicKey } = require("@solana/web3.js");
    const connection = getConnection();
    const dlmmPool = await DLMMClass.create(connection, new PublicKey(pos.pool));
    const activeBin = await dlmmPool.getActiveBin();
    const activeBinId = activeBin.binId;
    // Use stored binRange if available, else fetch from chain
    let lower, upper;
    if (pos.binRange?.lower != null && pos.binRange?.upper != null) {
      lower = pos.binRange.lower;
      upper = pos.binRange.upper;
    } else {
      const wallet = await getWallet();
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const posData = userPositions.find(p => p.publicKey.toString() === pos.positionAddress);
      if (!posData) return { outOfRange: false, reason: "position not found on-chain" };
      const binIds = (posData.positionData?.positionBinData ?? []).map(b => b.binId).filter(Number.isFinite);
      if (binIds.length === 0) return { outOfRange: false, reason: "no bin data" };
      lower = Math.min(...binIds);
      upper = Math.max(...binIds);
    }
    const outOfRange = activeBinId < lower || activeBinId > upper;
    const direction = activeBinId < lower ? "below" : activeBinId > upper ? "above" : null;
    return { outOfRange, activeBinId, binRange: { lower, upper }, direction };
  } catch (err) {
    console.warn(`[OOR] Check failed for ${positionId}: ${err.message}`);
    return { outOfRange: false, error: err.message };
  }
}

export async function calculateIL(pos) {
  return null; // IL tracking not implemented in VPS version
}
