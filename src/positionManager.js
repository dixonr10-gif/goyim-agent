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
import { getTokenPrice } from "./jupiterPrice.js";

const require = createRequire(import.meta.url);
import fs from "fs";
import path from "path";
const POSITIONS_FILE = path.resolve("data/open_positions.json");

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

async function getWallet() {
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

function getConnection() {
  const { Connection } = require("@solana/web3.js");
  return new Connection(config.rpcUrl, { commitment: "confirmed" });
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
    const connection = getConnection();
    const balance = await connection.getBalance(wallet.publicKey);
    return balance / 1e9;
  } catch (err) {
    console.error("Balance check failed:", err.message);
    return null;
  }
}

export async function openPosition(decision) {
  const { targetPool, strategy, binRange } = decision;
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

    const dlmmPool = await DLMMClass.create(connection, new PublicKey(targetPool));
    const tokenX = dlmmPool.tokenX?.publicKey?.toString();
    const tokenY = dlmmPool.tokenY?.publicKey?.toString();
    const WSOL = "So11111111111111111111111111111111111111112";

    console.log(`  Pool tokens: X=${tokenX?.slice(0,8)}... Y=${tokenY?.slice(0,8)}...`);

    const solIsX = tokenX === WSOL;
    const solIsY = tokenY === WSOL;
    if (!solIsX && !solIsY) throw new Error("Pool tidak ada SOL");

    const altToken = solIsX ? tokenY : tokenX;
    const check = await checkTokenViability(targetPool, altToken);
    if (!check.viable) throw new Error(`Token tidak viable: ${check.warnings.join(", ")}`);

    console.log(`✅ Token check passed! Score: ${check.score}`);
    console.log(`📋 Opening ${strategy} on ${targetPool}`);

    const activeBin = await dlmmPool.getActiveBin();
    const binCount = binRange?.upper ?? 20;
    const lowerBinId = solIsY ? activeBin.binId - binCount : activeBin.binId + 1;
    const upperBinId = solIsY ? activeBin.binId - 1 : activeBin.binId + binCount;
    const solLamports = Math.floor(config.maxSolPerPosition * 1e9);

    const positionKeypair = require("@solana/web3.js").Keypair.generate();

    // Retry on ExceededBinSlippageTolerance (AnchorError 6004): the active bin can
    // shift between quote and execution, so we start at 1% slippage and double to 2%
    // on a single bin-slippage failure before surfacing the error.
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
            strategyType: 0,
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

    // Fetch entry price for IL tracking (non-blocking — failure is OK)
    const entryTokenPrice = await getTokenPrice(altToken).catch(() => null);

    const positionId = "pos_" + Date.now();
    openPositions.set(positionId, {
      id: positionId,
      pool: targetPool,
      strategy: strategy ?? "spot",
      binRange: { lower: lowerBinId, upper: upperBinId },
      openedAt: new Date().toISOString(),
      solDeployed: config.maxSolPerPosition,
      walletAddress: wallet.publicKey.toString(),
      positionAddress: positionKeypair.publicKey.toString(),
      txSignature: sig,
      tokenCheck: check,
      altTokenMint: altToken,
      entryTokenPrice,
    });

    savePositions(openPositions);
    console.log(`✅ Real position opened: ${positionId}`);
    return positionId;

  } catch (err) {
    console.error("❌ Open TX failed:", err.message);
    console.error("Stack:", err.stack?.slice(0, 500));
    const positionId = "pos_" + Date.now();
    openPositions.set(positionId, {
      id: positionId,
      pool: targetPool,
      strategy: strategy ?? "spot",
      openedAt: new Date().toISOString(),
      solDeployed: config.maxSolPerPosition,
      mock: true,
      error: err.message,
    });
    console.log(`⚠️ Mock position: ${positionId}`);
    return positionId;
  }
}

export async function closePosition(positionId) {
  const pos = openPositions.get(positionId);
  if (!pos) throw new Error("Position not found");

  if (pos.mock) {
    openPositions.delete(positionId);
    savePositions(openPositions);
    console.log(`✅ Mock position closed: ${positionId}`);
    return true;
  }

  try {
    const DLMM = require("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;
    const { PublicKey, sendAndConfirmTransaction } = require("@solana/web3.js");
    const BN = require("bn.js");

    const wallet = await getWallet();
    const connection = getConnection();
    const dlmmPool = await DLMMClass.create(connection, new PublicKey(pos.pool));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const positionData = userPositions.find(p => p.publicKey.toString() === pos.positionAddress);

    if (!positionData) {
      // Verify the account actually doesn't exist on-chain before removing from local state.
      // getPositionsByUserAndLbPair can return incomplete results on RPC hiccups, so we
      // do a direct account fetch to confirm the position is truly gone.
      const accountInfo = await connection.getAccountInfo(new PublicKey(pos.positionAddress));
      if (accountInfo !== null) {
        throw new Error(`Position ${pos.positionAddress} not returned by DLMM SDK but account still exists on-chain — RPC may be lagging, skipping delete`);
      }
      // Account is confirmed absent on-chain; safe to clean up local state.
      openPositions.delete(positionId);
      savePositions(openPositions);
      console.log(`⚠️ Position ${positionId} already closed on-chain, removed from local state`);
      return true;
    }

    const binIds = positionData.positionData.positionBinData.map(b => b.binId).filter(Number.isFinite);
    const fromBinId = Math.min(...binIds);
    const toBinId = Math.max(...binIds);
    const removeParams = {
      position: new PublicKey(pos.positionAddress),
      user: wallet.publicKey,
      fromBinId,
      toBinId,
      bps: new BN(10000),
      shouldClaimAndClose: true,
    };

    // Capture SOL balance before close TXs to compute actual solReceived
    const preBalance = await connection.getBalance(wallet.publicKey);

    // Retry loop: rebuild the TX on each attempt so we always have a fresh blockhash.
    // sendAndConfirmTransaction can fail if the blockhash expires (~13s window) or the
    // RPC drops the TX, so retrying with a freshly-built transaction is the safe fix.
    const MAX_ATTEMPTS = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (attempt > 1) {
          console.log(`🔄 Close TX retry ${attempt}/${MAX_ATTEMPTS}...`);
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
        const removeTx = await dlmmPool.removeLiquidity(removeParams);
        for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
          const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
            commitment: "confirmed",
            skipPreflight: false,
          });
          console.log(`✅ Close TX: https://solscan.io/tx/${sig}`);
        }
        lastErr = null;
        break; // success — exit retry loop
      } catch (err) {
        lastErr = err;
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

    openPositions.delete(positionId);
    savePositions(openPositions);
    return { success: true, solReceived };
  } catch (err) {
    console.error("❌ Close TX failed:", err.message);
    throw err;
  }
}

export function getOpenPositions() {
  return Array.from(openPositions.values());
}

/**
 * Check whether the pool's active bin has moved outside the position's bin range.
 * Returns { outOfRange, activeBinId, binRange, direction } where direction is
 * 'above' | 'below' | null.  Returns outOfRange:false on any fetch error so a
 * transient RPC hiccup never triggers a spurious exit.
 */
export async function checkOutOfRange(positionId) {
  const pos = openPositions.get(positionId);
  if (!pos || pos.mock || !pos.binRange || !pos.positionAddress) {
    return { outOfRange: false, reason: "no bin range data" };
  }

  try {
    const DLMM = require("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;
    const { PublicKey } = require("@solana/web3.js");

    const connection = getConnection();
    const dlmmPool = await DLMMClass.create(connection, new PublicKey(pos.pool));
    const activeBin = await dlmmPool.getActiveBin();
    const activeBinId = activeBin.binId;

    const { lower, upper } = pos.binRange;
    const outOfRange = activeBinId < lower || activeBinId > upper;
    const direction = activeBinId < lower ? "below" : activeBinId > upper ? "above" : null;

    return { outOfRange, activeBinId, binRange: pos.binRange, direction };
  } catch (err) {
    console.warn(`[OOR] Check failed for ${positionId}: ${err.message}`);
    return { outOfRange: false, error: err.message };
  }
}

/**
 * Returns the current on-chain SOL value of a position.
 * Sums token X/Y amounts across all bins and returns the SOL side in SOL units.
 * Falls back to pos.solDeployed on any RPC error so exit evaluation still works.
 */
export async function getPositionValue(pos) {
  if (!pos || pos.mock || !pos.positionAddress) {
    return pos?.solDeployed ?? 0;
  }
  try {
    const DLMM = require("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;
    const { PublicKey } = require("@solana/web3.js");
    const BN = require("bn.js");

    const connection = getConnection();
    const wallet = await getWallet();
    const dlmmPool = await DLMMClass.create(connection, new PublicKey(pos.pool));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const positionData = userPositions.find(p => p.publicKey.toString() === pos.positionAddress);

    if (!positionData) return pos.solDeployed;

    const WSOL = "So11111111111111111111111111111111111111112";
    const solIsX = dlmmPool.tokenX?.publicKey?.toString() === WSOL;

    let totalLamports = new BN(0);
    for (const bin of positionData.positionData.positionBinData) {
      totalLamports = totalLamports.add(new BN(solIsX ? (bin.amountX ?? 0) : (bin.amountY ?? 0)));
    }

    return totalLamports.toNumber() / 1e9;
  } catch (err) {
    console.warn(`[VALUE] Failed for ${pos?.id}: ${err.message}`);
    return pos?.solDeployed ?? 0;
  }
}

/**
 * Safe on-chain sync: ONLY adds missing positions back, never deletes.
 * Protects against open_positions.json going blank after restart.
 */
export async function syncOnChainPositions() {
  try {
    const DLMM = require("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;

    const wallet = await getWallet();
    const connection = getConnection();

    let positionsByLbPair;
    try {
      positionsByLbPair = await DLMMClass.getAllLbPairPositionsByUser(connection, wallet.publicKey);
    } catch (sdkErr) {
      // If the SDK call fails we never touch local state
      console.warn("[SYNC] getAllLbPairPositionsByUser failed:", sdkErr.message);
      return;
    }

    if (!positionsByLbPair) return;

    // Build set of position addresses already tracked locally
    const localAddresses = new Set(
      Array.from(openPositions.values())
        .filter(p => p.positionAddress)
        .map(p => p.positionAddress)
    );

    // SDK returns Map<string, PositionInfo> — handle both Map and plain object
    const entries = positionsByLbPair instanceof Map
      ? [...positionsByLbPair.entries()]
      : Object.entries(positionsByLbPair);

    console.log(`[SYNC] Found ${entries.length} LB pair(s) on-chain`);

    let recovered = 0;
    for (const [lbPairAddr, pairData] of entries) {
      for (const posInfo of pairData.lbPairPositionsData ?? []) {
        const addr = posInfo.publicKey?.toString();
        if (!addr || localAddresses.has(addr)) continue;

        // This position exists on-chain but is missing from local state — recover it
        const binData = posInfo.positionData?.positionBinData ?? [];
        const binIds = binData.map(b => b.binId).filter(Number.isFinite);
        const binRange = binIds.length > 0
          ? { lower: Math.min(...binIds), upper: Math.max(...binIds) }
          : undefined;

        // Resolve pool name from Meteora API so blacklist tracking works
        let poolName = null;
        try {
          const pairRes = await fetch(`https://dlmm.datapi.meteora.ag/pair/${lbPairAddr}`, { signal: AbortSignal.timeout(8000) });
          if (pairRes.ok) { const pd = await pairRes.json(); poolName = pd.name ?? null; }
        } catch {}
        if (!poolName) {
          try {
            const dxRes = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${lbPairAddr}`, { signal: AbortSignal.timeout(8000) });
            const dxData = await dxRes.json();
            const pair = dxData?.pair ?? dxData?.pairs?.[0];
            if (pair) poolName = `${pair.baseToken?.symbol ?? "?"}-${pair.quoteToken?.symbol ?? "?"}`;
          } catch {}
        }

        const recoveryId = "recovered_" + Date.now() + "_" + Math.random().toString(36).slice(2, 5);
        openPositions.set(recoveryId, {
          id: recoveryId,
          pool: lbPairAddr,
          poolName,
          strategy: "spot",
          openedAt: new Date().toISOString(),
          solDeployed: config.maxSolPerPosition,
          positionAddress: addr,
          binRange,
          recovered: true,
          recoveredAt: new Date().toISOString(),
        });
        console.log(`[SYNC] ✅ Recovered: ${addr.slice(0, 8)}... (pool: ${lbPairAddr.slice(0, 8)}...) name: ${poolName ?? "unknown"}`);
        recovered++;
      }
    }

    if (recovered > 0) {
      savePositions(openPositions);
      console.log(`[SYNC] Recovered ${recovered} position(s) from on-chain`);
    } else {
      console.log(`[SYNC] ${openPositions.size} local position(s) verified`);
    }
  } catch (err) {
    console.warn("[SYNC] Sync error — local state preserved:", err.message);
  }
}

/**
 * Calculate approximate impermanent loss for a position.
 * Uses standard AMM IL formula: IL = 2√p/(1+p) - 1 where p = currentPrice/entryPrice.
 * Returns null if entry price was not recorded or price fetch fails.
 */
export async function calculateIL(pos) {
  if (!pos || pos.mock || !pos.entryTokenPrice || !(pos.entryTokenPrice > 0) || !pos.altTokenMint) {
    return null;
  }
  try {
    const currentPrice = await getTokenPrice(pos.altTokenMint);
    if (!currentPrice || currentPrice <= 0) return null;
    const p = currentPrice / pos.entryTokenPrice;
    const il = (2 * Math.sqrt(p) / (1 + p)) - 1;
    return {
      ilPercent: (il * 100).toFixed(2),
      priceRatio: p.toFixed(4),
      currentPrice,
      entryPrice: pos.entryTokenPrice,
    };
  } catch {
    return null;
  }
}

/**
 * Close an OOR position and immediately reopen at the current active bin range.
 * Returns the new position ID, or throws if either step fails.
 */
export async function rebalancePosition(positionId) {
  const pos = openPositions.get(positionId);
  if (!pos) throw new Error(`Position ${positionId} not found for rebalance`);

  console.log(`🔄 Rebalancing ${positionId} (pool: ${pos.pool?.slice(0, 8)}...)...`);
  await closePosition(positionId);

  // OOR-right only: let the pump cool off before re-entering at the new active bin,
  // so we don't immediately get pushed out of range again by continuing momentum.
  console.log(`  [Rebalance] OOR-right: waiting 5min before re-open...`);
  await new Promise(r => setTimeout(r, 300_000));

  const newPosId = await openPosition({
    targetPool: pos.pool,
    strategy: pos.strategy ?? "spot",
    binRange: { upper: 20 },
    confidence: 70,
    rationale: "auto-rebalance after OOR",
  });

  console.log(`✅ Rebalance complete: ${positionId} → ${newPosId}`);
  return newPosId;
}







