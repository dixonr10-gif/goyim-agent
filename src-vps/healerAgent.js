// src-vps/healerAgent.js
// Healer Agent — monitors positions, executes exits every 10 min

import { getOpenPositions, closePosition, getPositionValue, syncOnChainPositions } from "./positionManager.js";
import { evaluateExits } from "./exitStrategy.js";

// 200ms pacer between per-position RPC batches to avoid bursting Helius's rate limit
// when Healer has multiple open positions to evaluate/close in a single cycle.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
import { recordLastRun } from "./healthCheck.js";
import { recordTradeClose, getFullStats } from "./tradeMemory.js";
import { maybeEvolveThresholds } from "./thresholdEvolver.js";
import { analyzeClosedTrade } from "./postTradeAnalyzer.js";
import { notifyPositionClosed, notifyError, notifyMessage, isAgentPaused, esc } from "./telegramBot.js";
import { autoSwapTokensToSOL, retryPendingSwaps } from "./autoSwap.js";
import { recordTokenLoss, recordOORStrike } from "./blacklistManager.js";
import { checkAndClaimFees } from "./feeCompounder.js";
import { recordPoolClose } from "./poolMemory.js";

let healerIteration = 0;

export async function runHealer() {
  if (isAgentPaused()) { console.log("⏸️ [Healer] paused"); return; }

  healerIteration++;
  console.log(`\n${"─".repeat(40)}`);
  console.log(`💊 Healer Agent — Iteration #${healerIteration} | ${new Date().toLocaleTimeString()}`);

  try {
    // Retry any pending swaps from previous failed attempts
    try { await retryPendingSwaps(notifyMessage); } catch {}

    // Drain any OOR-right rebalances whose 5-min wait has elapsed.
    // File-backed (data/pending_reopen.json) so the wait survives PM2 restarts.
    try {
      const { processPendingReopens } = await import("./positionManager.js");
      await processPendingReopens();
    } catch (e) { console.warn("[PendingReopen] cycle error:", e.message); }

    const syncResult = await syncOnChainPositions();
    const manualCloses = syncResult?.manuallyClosedPositions ?? [];

    // Handle manually closed positions
    if (manualCloses.length > 0) {
      for (const pos of manualCloses) {
        try {
          console.log(`  [ManualClose] recording ${pos.id} (${pos.poolName ?? pos.pool?.slice(0,8)})`);
          recordTradeClose({ positionId: pos.id, solReturned: pos.solDeployed ?? 0, poolName: pos.poolName, solDeployed: pos.solDeployed, closeReason: "MANUAL", binRange: pos.binRange, solPriceAtEntry: pos.solPriceAtEntry, solPriceAtClose: pos.solPriceAtEntry });
          await notifyMessage(
            `🔄 <b>Manual close detected</b>\n\n` +
            `Pool: ${esc(pos.poolName ?? "?")}\n` +
            `SOL deployed: ${pos.solDeployed ?? "?"}\n\n` +
            `Auto-swapping token sisa...`
          );
        } catch {}
      }
      console.log(`  [ManualClose] triggering autoSwap for token sisa`);
      console.log(`[AutoSwap] Triggered after MANUAL close`);
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

        // Stamp _slHandledAt to prevent double-close between overlapping healer cycles.
        // exitStrategy.js already stamps this for SL paths; this catches other exits.
        try { const { updatePositionField } = await import("./positionManager.js"); updatePositionField(exit.positionId, "_slHandledAt", Date.now()); } catch {}

        // Resolve closeReason BEFORE the close TX so cooldownManager picks the
        // right per-reason duration when closePosition sets the cooldown.
        // Prefer structured code from exitStrategy (set on every toClose.push since
        // the audit fix). Fall back to parsing the human-readable reason string for
        // resilience against any unstructured push that may sneak in.
        const pos = openPos.find(p => p.id === exit.positionId);
        let closeReason = exit.code ?? null;
        if (!closeReason) {
          const r = (exit.reason ?? "").toLowerCase();
          if (r.includes("position gone") || r.includes("external close")) closeReason = "POSITION_GONE";
          else if (r.includes("out of range")) {
            const dir = pos?.oorDirection;
            closeReason = dir === "left" ? "OOR_LEFT" : dir === "right" ? "OOR_RIGHT" : "OOR";
          }
          else if (r.includes("trailing")) closeReason = "TRAILING_TP";
          else if (r.includes("fee take-profit") || r.includes("fee tp")) closeReason = "FEE_TP";
          else if (r.includes("stop loss") || r.includes("stop-loss")) closeReason = "SL";
          else if (r.includes("take profit") || r.includes("take-profit")) closeReason = "TP";
          else if (r.includes("max hold")) closeReason = "MAX_HOLD";
          else if (r.includes("fee apr")) closeReason = "FEE_APR_FLOOR";
          else if (r.includes("volatility")) closeReason = "VOLATILITY";
          else closeReason = "UNKNOWN";
        }

        const result = await closePosition(exit.positionId, { reason: closeReason, pnlPct: preClosePnlPct });
        const txSignatures = result?.txSignatures ?? [];
        const solReturned = exit.currentValue ?? result?.solReceived ?? pos?.solDeployed;

        // Fetch SOL/USD at close so tradeMemory can record pnlUsd.  Uses the same
        // CoinGecko endpoint as positionManager.openPosition; failure is OK —
        // recordTradeClose falls back to (pnlSol × solPriceAtEntry).
        let solPriceAtClose = null;
        try {
          const priceRes = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
            { signal: AbortSignal.timeout(8000) }
          );
          const priceData = await priceRes.json();
          const p = priceData?.solana?.usd;
          if (typeof p === "number" && p > 10) solPriceAtClose = p;
        } catch {}

        const closedTrade = recordTradeClose({ positionId: exit.positionId, solReturned, preClosePnlPct, poolName: pos?.poolName, solDeployed: pos?.solDeployed, closeReason, binRange: pos?.binRange, solPriceAtEntry: pos?.solPriceAtEntry, solPriceAtClose });
        await notifyPositionClosed(exit.positionId, exit.reason, txSignatures);
        closedCount++;

        // Wait for close TX to finalize on-chain before checking token balances
        console.log(`🔄 Waiting 20s for tokens to settle, then auto-swapping...`);
        console.log(`[AutoSwap] Triggered after ${closeReason} close`);
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
      await sleep(200);
    }

    if (closedCount === 0 && exits.length === 0) {
      console.log("  ✅ All positions healthy — no exits triggered.");
    }

    // Check and claim fees for open positions (momentum-based)
    for (const pos of getOpenPositions()) {
      try { await checkAndClaimFees(pos, notifyMessage); } catch {}
      await sleep(200);
    }

  } catch (err) {
    console.error("\n🔥 Healer error:", err.message);
    await notifyError(`[Healer] ${err.message}`);
  }
  recordLastRun("healer");
}
