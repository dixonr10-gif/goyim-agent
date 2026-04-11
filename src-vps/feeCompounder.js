// src/feeCompounder.js — Claim fees from DLMM positions using claimAllRewards()
// Called from healerAgent every cycle, with cooldown + momentum check

import { createRequire } from "module";
import { config } from "../config.js";
import { getWallet, getConnection } from "./positionManager.js";
import { esc } from "./telegramBot.js";

const require = createRequire(import.meta.url);

const MIN_CLAIM_USD = 8;
const CLAIM_COOLDOWN_MS = 30 * 60 * 1000; // 30 min per position
const _lastClaimTime = {};

export async function checkAndClaimFees(position, notifyFn = null) {
  if (!position?.pool || !position?.positionAddress) return;

  try {
    // Cooldown check
    if (_lastClaimTime[position.id] && Date.now() - _lastClaimTime[position.id] < CLAIM_COOLDOWN_MS) return;

    const DLMM = require("@meteora-ag/dlmm");
    const DLMMClass = DLMM.default ?? DLMM;
    const { PublicKey, sendAndConfirmTransaction } = require("@solana/web3.js");
    const wallet = await getWallet();
    const connection = getConnection();

    const dlmmPool = await DLMMClass.create(connection, new PublicKey(position.pool));
    const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
    const posData = userPositions.find(p => p.publicKey.toString() === position.positionAddress);
    if (!posData) return;

    // Calculate fees from bin data (same source as getPositionValue)
    const WSOL = "So11111111111111111111111111111111111111112";
    const tokenXMint = dlmmPool.tokenX?.publicKey?.toString();
    const xIsSol = tokenXMint === WSOL;
    const decX = dlmmPool.tokenX?.decimal ?? dlmmPool.tokenX?.decimals ?? 9;
    const decY = dlmmPool.tokenY?.decimal ?? dlmmPool.tokenY?.decimals ?? 9;

    let binFeeX = 0, binFeeY = 0;
    for (const bin of posData.positionData?.positionBinData ?? []) {
      binFeeX += parseFloat(bin.positionFeeXAmount ?? 0) / (10 ** decX);
      binFeeY += parseFloat(bin.positionFeeYAmount ?? 0) / (10 ** decY);
    }
    const feeSol = xIsSol ? binFeeX : binFeeY;
    const feeToken = xIsSol ? binFeeY : binFeeX;
    if (feeSol < 0.001 && feeToken < 0.001) return;

    // SOL price
    let solPrice = 80;
    try {
      const pr = await fetch("https://lite.jupiterapi.com/price?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(5000) });
      const pd = await pr.json();
      const p = pd?.data?.So11111111111111111111111111111111111111112?.price;
      if (typeof p === "number" && p > 10) solPrice = p;
    } catch {}

    // Token price via pool active bin
    const activeBin = await dlmmPool.getActiveBin();
    const pricePerToken = parseFloat(activeBin.pricePerToken ?? 0);
    const tokenPriceUsd = xIsSol ? (pricePerToken > 0 ? solPrice / pricePerToken : 0) : pricePerToken * solPrice;
    const tokenFeeUsd = feeToken * tokenPriceUsd;
    const solFeeUsd = feeSol * solPrice;
    const totalUsd = tokenFeeUsd + solFeeUsd;
    console.log(`  [Fees] ${position.poolName ?? position.pool?.slice(0,8)}: $${totalUsd.toFixed(2)} claimable (sol=$${solFeeUsd.toFixed(2)} token=$${tokenFeeUsd.toFixed(2)})`);

    if (totalUsd < MIN_CLAIM_USD) return;

    // Check momentum — only claim when token is pumping (fees will be replaced quickly)
    let priceChange1h = 0;
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${position.pool}`, { signal: AbortSignal.timeout(6000) });
      const data = await res.json();
      const pair = data?.pair ?? data?.pairs?.[0];
      priceChange1h = parseFloat(pair?.priceChange?.h1 ?? "0");
    } catch {}

    if (priceChange1h < 10) return; // only claim when token strongly trending up

    console.log(`  [Fees] Claiming $${totalUsd.toFixed(2)} from ${position.poolName ?? position.pool?.slice(0, 8)} (1h: +${priceChange1h.toFixed(1)}%)`);

    // Claim all rewards (fees + LM)
    const claimTxs = await dlmmPool.claimAllRewards({
      owner: wallet.publicKey,
      positions: [posData],
    });

    const txArray = Array.isArray(claimTxs) ? claimTxs : (claimTxs ? [claimTxs] : []);
    for (const tx of txArray) {
      const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
      console.log(`  ✅ Fees claimed: https://solscan.io/tx/${sig}`);
    }

    _lastClaimTime[position.id] = Date.now();

    // Track claimed fees for PnL accuracy
    try {
      const { updatePositionField } = await import("./positionManager.js");
      const prev = position.claimedFeesUsd ?? 0;
      updatePositionField(position.id, "claimedFeesUsd", prev + totalUsd);
      console.log(`  📊 Cumulative claimed: $${(prev + totalUsd).toFixed(2)}`);
    } catch {}

    // Notify
    if (notifyFn) {
      await notifyFn(
        `💰 <b>Fees Claimed!</b>\n\n` +
        `Pool: ${esc(position.poolName ?? "?")}\n` +
        `SOL fees: ${feeSol.toFixed(4)} SOL ($${solFeeUsd.toFixed(2)})\n` +
        `Token fees: ~$${tokenFeeUsd.toFixed(2)}\n` +
        `Total: <b>$${totalUsd.toFixed(2)}</b>\n` +
        `Momentum: 1h +${priceChange1h.toFixed(1)}%`
      );
    }
  } catch (err) {
    if (!err.message?.includes("No fee") && !err.message?.includes("No LM")) {
      console.log(`  [Fees] Claim error: ${err.message?.slice(0, 80)}`);
    }
  }
}

// Legacy exports — keep startFeeCompounder for index.js compat but make it a no-op
// Fee claiming is now done in healerAgent via checkAndClaimFees()
export function startFeeCompounder() {
  console.log("💰 Fee claiming integrated into healer cycle (no separate compounder)");
}
export function stopFeeCompounder() {}
