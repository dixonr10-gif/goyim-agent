// src-vps/healerAgent.js
// Healer Agent — monitors positions, executes exits every 10 min

import { getOpenPositions, closePosition, getPositionValue, syncOnChainPositions } from "./positionManager.js";
import { evaluateExits } from "./exitStrategy.js";
import { recordLastRun } from "./healthCheck.js";
import { recordTradeClose, getFullStats } from "./tradeMemory.js";
import { maybeEvolveThresholds } from "./thresholdEvolver.js";
import { analyzeClosedTrade } from "./postTradeAnalyzer.js";
import { notifyPositionClosed, notifyError, notifyMessage, isAgentPaused } from "./telegramBot.js";
import { autoSwapTokensToSOL, retryPendingSwaps } from "./autoSwap.js";
import { recordTokenLoss, recordOORStrike } from "./blacklistManager.js";
import { checkAndClaimFees } from "./feeCompounder.js";
import { recordPoolClose } from "./poolMemory.js";

let healerIteration = 0;

// Emergency PnL check — uses same getPositionValue as healer (usd-precise)
export async function runEmergencyPriceCheck() {
  try {
    const openPos = getOpenPositions();
    if (openPos.length === 0) return;

    for (const pos of openPos) {
      try {
        const currentValue = await getPositionValue(pos);
        if (pos._badData || pos._positionGone) continue;
        const solPrice = pos._solPriceNow ?? 0;
        const posValueUsd = pos._posValueUsd ?? 0;
        if (posValueUsd <= 0 || solPrice <= 0) continue;

        const entryUsd = pos.solDeployed * (pos.solPriceAtEntry || solPrice);
        if (entryUsd <= 0) continue;
        const pnlPct = ((posValueUsd - entryUsd) / entryUsd) * 100;

        if (pnlPct <= -15) {
          console.log(`  [EmergencyExit] ${pos.poolName ?? pos.id}: PnL=${pnlPct.toFixed(1)}% (value=$${posValueUsd.toFixed(2)} entry=$${entryUsd.toFixed(2)}) → closing NOW`);
          try {
            const result = await closePosition(pos.id);
            const txSigs = result?.txSignatures ?? [];
            const solReturned = result?.solReceived ?? pos.solDeployed;
            const closedTrade = recordTradeClose({ positionId: pos.id, solReturned, preClosePnlPct: pnlPct, poolName: pos.poolName, solDeployed: pos.solDeployed, closeReason: "EMERGENCY_SL" });
            await notifyPositionClosed(pos.id, `emergency exit: PnL ${pnlPct.toFixed(1)}%`, txSigs);
            if (closedTrade?.outcome === "loss") {
              try { recordTokenLoss(closedTrade.poolName); } catch {}
            }
            await new Promise(r => setTimeout(r, 15000));
            await autoSwapTokensToSOL(notifyMessage);
          } catch (e) { console.log(`  [EmergencyExit] Close failed: ${e.message}`); }
        }
      } catch {}
    }
  } catch {}
}

export async function runHealer() {
  if (isAgentPaused()) { console.log("⏸️ [Healer] paused"); return; }

  healerIteration++;
  console.log(`\n${"─".repeat(40)}`);
  console.log(`💊 Healer Agent — Iteration #${healerIteration} | ${new Date().toLocaleTimeString()}`);

  try {
    // Retry any pending swaps from previous failed attempts
    try { await retryPendingSwaps(notifyMessage); } catch {}

    const syncResult = await syncOnChainPositions();
    const manualCloses = syncResult?.manuallyClosedPositions ?? [];

    // Handle manually closed positions
    if (manualCloses.length > 0) {
      for (const pos of manualCloses) {
        try {
          console.log(`  [ManualClose] recording ${pos.id} (${pos.poolName ?? pos.pool?.slice(0,8)})`);
          recordTradeClose({ positionId: pos.id, solReturned: pos.solDeployed ?? 0, poolName: pos.poolName, solDeployed: pos.solDeployed, closeReason: "MANUAL" });
          await notifyMessage(
            `🔄 <b>Manual close detected</b>\n\n` +
            `Pool: ${pos.poolName ?? "?"}\n` +
            `SOL deployed: ${pos.solDeployed ?? "?"}\n\n` +
            `Auto-swapping token sisa...`
          );
        } catch {}
      }
      console.log(`  [ManualClose] triggering autoSwap for token sisa`);
      await new Promise(r => setTimeout(r, 10000));
      await autoSwapTokensToSOL(notifyMessage);
    }

    const openPos = getOpenPositions();

    if (openPos.length === 0) {
      console.log("  💊 No positions to monitor.");
      recordLastRun("healer");
      return;
    }

    console.log(`  Monitoring ${openPos.length} position(s)...`);
    const exits = await evaluateExits(
      openPos,
      null,
      async (pos) => getPositionValue(pos),
    );

    let closedCount = 0;
    for (const exit of exits) {
      try {
        // exit.pnlPercent is computed by exitStrategy via getPositionValue() (counts all bins: SOL + token)
        // This is the most accurate PnL — wallet SOL delta only counts SOL received, misses tokens
        const preClosePnlPct = typeof exit.pnlPercent === "number" ? exit.pnlPercent : null;
        console.log(`[PNL] Pre-close PnL for ${exit.positionId}: ${preClosePnlPct?.toFixed(2) ?? "null"}% (from exitStrategy)`);

        const result = await closePosition(exit.positionId);
        const txSignatures = result?.txSignatures ?? [];
        const pos = openPos.find(p => p.id === exit.positionId);
        const solReturned = exit.currentValue ?? result?.solReceived ?? pos?.solDeployed;
        // Derive closeReason from exit.reason string
        let closeReason = "UNKNOWN";
        const r = (exit.reason ?? "").toLowerCase();
        if (r.includes("out of range")) closeReason = r.includes("left") || r.includes("dump") ? "OOR_LEFT" : "OOR_RIGHT";
        else if (r.includes("trailing")) closeReason = "TRAILING_TP";
        else if (r.includes("stop") || r.includes("sl")) closeReason = "SL";
        else if (r.includes("take profit") || r.includes("fee tp")) closeReason = "TP";
        else if (r.includes("max hold")) closeReason = "MAX_HOLD";
        else if (r.includes("fee apr")) closeReason = "FEE_APR_FLOOR";
        else if (r.includes("volatility")) closeReason = "VOLATILITY";
        const closedTrade = recordTradeClose({ positionId: exit.positionId, solReturned, preClosePnlPct, poolName: pos?.poolName, solDeployed: pos?.solDeployed, closeReason });
        await notifyPositionClosed(exit.positionId, exit.reason, txSignatures);
        closedCount++;

        // Wait for close TX to finalize on-chain before checking token balances
        console.log(`🔄 Waiting 20s for tokens to settle, then auto-swapping...`);
        await new Promise(r => setTimeout(r, 20000));
        await autoSwapTokensToSOL(notifyMessage);

        if (closedTrade) {
          if (closedTrade.outcome === "loss") {
            try { recordTokenLoss(closedTrade.poolName); } catch {}
          }
          if (exit.reason?.includes("out of range")) {
            try { recordOORStrike(closedTrade.poolName ?? pos?.poolName); } catch {}
          }
          maybeEvolveThresholds(getFullStats().stats);
          const holdMin = parseFloat(closedTrade.holdDurationHours ?? 0) * 60;
          try { recordPoolClose(pos?.pool, parseFloat(closedTrade.pnlPercent ?? 0), closedTrade.outcome, holdMin); } catch {}
          analyzeClosedTrade(closedTrade, {}).catch(() => {});
        }
      } catch (closeErr) {
        console.log(`  [Healer] Close failed for ${exit.positionId}: ${closeErr.message?.slice(0, 80)}`);
        if (closeErr.message?.includes("not found") || closeErr.message?.includes("0 positions")) {
          try { const { recordGhostStrike } = await import("./positionManager.js"); recordGhostStrike(exit.positionId, closeErr.message); } catch {}
        }
      }
    }

    if (closedCount === 0 && exits.length === 0) {
      console.log("  ✅ All positions healthy — no exits triggered.");
    }

    // Check and claim fees for open positions (momentum-based)
    for (const pos of getOpenPositions()) {
      try { await checkAndClaimFees(pos, notifyMessage); } catch {}
    }

  } catch (err) {
    console.error("\n🔥 Healer error:", err.message);
    await notifyError(`[Healer] ${err.message}`);
  }
  recordLastRun("healer");
}
