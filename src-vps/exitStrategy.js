import fs from "fs";
import { config } from "../config.js";
import { isStrictHours } from "./timeHelper.js";

async function fetchTokenPriceChange1h(tokenMint) {
  if (!tokenMint) return null;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`, {
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const pairs = (data?.pairs ?? []).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const val = parseFloat(pairs[0]?.priceChange?.h1 ?? "NaN");
    return Number.isFinite(val) ? val : null;
  } catch { return null; }
}

const EXIT_RULES = {
  takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 25,
  stopLossPercent: parseFloat(process.env.STOP_LOSS_PCT ?? process.env.STOP_LOSS_PERCENT) || -6,
  maxHoldHours: parseFloat(process.env.MAX_HOLD_HOURS) || 48,
  minFeeAprToHold: parseFloat(process.env.MIN_FEE_APR_TO_HOLD) || 10,
};

// USD PnL using actual token+SOL prices (set by getPositionValue on position._posValueUsd)
function calcUsdPnl(position, currentValueSol, currentSolPrice) {
  if (currentSolPrice <= 0) return null;

  const solPriceAtEntry = position.solPriceAtEntry || currentSolPrice;
  const entryValueUsd   = position.solDeployed * solPriceAtEntry;

  // Prefer precise USD from getPositionValue (SOL*solPrice + token*tokenPrice)
  const currentValueUsd = (position._posValueUsd && position._posValueUsd > 0)
    ? position._posValueUsd
    : currentValueSol * currentSolPrice;

  const pnlUsd = currentValueUsd - entryValueUsd;
  const pnlPct = (pnlUsd / entryValueUsd) * 100;
  const source = position._posValueUsd ? "usd-precise" : "usd-sol-estimate";

  console.log(`[PNL] ${source}: entry=$${entryValueUsd.toFixed(2)} (SOL@$${solPriceAtEntry.toFixed(0)}) current=$${currentValueUsd.toFixed(2)} (SOL@$${currentSolPrice.toFixed(0)}) → pnl=${pnlPct.toFixed(2)}%`);
  return { pnlUsd, pnlPct, currentValueUsd, entryValueUsd, source };
}

export function shouldExitPosition(position, currentPoolData, currentValue) {
  const checks = [
    checkTakeProfit(position, currentValue),
    checkStopLoss(position, currentValue),
    checkMaxHoldTime(position),
    false,
    false,
  ];
  const exitSignal = checks.find((c) => c.shouldExit);
  if (exitSignal) return exitSignal;
  return { shouldExit: false, reason: "holding — no exit condition met" };
}

export async function evaluateExits(openPositions, getPoolData, getPositionValue) {
  const toClose = [];

  for (const position of openPositions) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      if (!position || !position.id) continue;

      // ── PnL via getPositionValue (SOL+token amounts → USD) ───────────
      let pnlPercent = 0;
      let currentValue = null;
      let pnlSource = "none";

      try {
        currentValue = await getPositionValue(position);
        // Position gone on-chain → force close to clean up
        if (position._positionGone) {
          console.log(`  🗑️ ${position.id}: position gone on-chain — forcing close`);
          toClose.push({ positionId: position.id, code: "POSITION_GONE", reason: "position gone on-chain (external close)", pnlPercent: 0, currentValue: 0 });
          continue;
        }
        // Bad data → skip this cycle entirely, don't make decisions on garbage
        if (position._badData || (currentValue === 0 && !position._positionGone)) {
          console.log(`  ⚠️ ${position.id}: [Exit] bad price data — skipping evaluation, will retry next cycle`);
          continue;
        }
        const solPrice = position._solPriceNow ?? 0;
        if (currentValue && currentValue > 0 && solPrice > 0) {
          const usdPnl = calcUsdPnl(position, currentValue, solPrice);
          if (usdPnl) {
            pnlPercent = usdPnl.pnlPct;
            pnlSource  = usdPnl.source;
          }
        }
        // USD-precise unavailable — tier 1 SL skipped, but tiers 2/3 still
        // fire via SOL-based fallback below (after repair attempt).
        if (pnlSource === "none") {
          console.log(`  ⚠️ ${position.id}: [PnL] usd-precise unavailable — tier 1 skipped, hardSL/panicSL fallback active`);
        }
      } catch (e) { console.log("[PNL] getPositionValue error:", e.message); }

      const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / 3_600_000;
      console.log(`  📊 ${position.id}: PnL=${pnlPercent.toFixed(2)}% [${pnlSource}] | hold=${holdHours.toFixed(1)}h`);

      // If PnL unavailable, try to repair entryPrice and retry once
      if (pnlSource === "none") {
        try {
          const { updatePositionField } = await import("./positionManager.js");
          if (!position.solPriceAtEntry || position.solPriceAtEntry === 0) {
            const prRes = await fetch("https://lite.jupiterapi.com/price?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(5000) });
            const prData = await prRes.json();
            const solP = prData?.data?.So11111111111111111111111111111111111111112?.price;
            if (typeof solP === "number" && solP > 10) {
              position.solPriceAtEntry = solP;
              updatePositionField(position.id, "solPriceAtEntry", solP);
              // Retry PnL with repaired price
              const retryValue = await getPositionValue(position);
              const retryPrice = position._solPriceNow ?? solP;
              if (retryValue && retryValue > 0 && retryPrice > 0) {
                const retryPnl = calcUsdPnl(position, retryValue, retryPrice);
                if (retryPnl) { pnlPercent = retryPnl.pnlPct; pnlSource = retryPnl.source; currentValue = retryValue; }
              }
              console.log(`  [PnL] Repaired entryPrice=$${solP.toFixed(0)} → PnL=${pnlPercent.toFixed(2)}% [${pnlSource}]`);
            }
          }
        } catch {}
      }

      // If still no PnL after repair attempt
      const effectiveMaxHold = isStrictHours() ? 2 : EXIT_RULES.maxHoldHours;
      if (pnlSource === "none") {
        // ── SOL-based fallback for hardSL / panicSL (tiers 2 & 3) ──────
        // USD-precise is unavailable, but a -30% loss is a -30% loss regardless
        // of precision. Compute SOL-based PnL and fire tiers 2/3 if breached.
        // Only tier 1 (noise zone -6% to -10%) requires usd-precise confirmation.
        const dep = position.solDeployed ?? 0;
        if (currentValue != null && currentValue > 0 && dep > 0) {
          const solPnlPct = ((currentValue - dep) / dep) * 100;
          const fallbackSL = isStrictHours() ? -4 : EXIT_RULES.stopLossPercent;
          const fallbackHardSL  = fallbackSL * 1.7;
          const fallbackPanicSL = fallbackSL * 2.5;

          if (solPnlPct <= fallbackPanicSL) {
            console.log(`  💀 ${position.id}: PANIC SL (sol-fallback) ${solPnlPct.toFixed(1)}% (≤${fallbackPanicSL.toFixed(1)}%) — closing immediately`);
            try { const { updatePositionField } = await import("./positionManager.js"); updatePositionField(position.id, "_slHandledAt", Date.now()); } catch {}
            toClose.push({ positionId: position.id, code: "SL", reason: `panic SL: ${solPnlPct.toFixed(1)}% [sol-fallback]`, pnlPercent: solPnlPct, currentValue });
            continue;
          }
          if (solPnlPct <= fallbackHardSL) {
            console.log(`  🛑 ${position.id}: HARD SL (sol-fallback) ${solPnlPct.toFixed(1)}% (≤${fallbackHardSL.toFixed(1)}%) — closing (no wait)`);
            try { const { updatePositionField } = await import("./positionManager.js"); updatePositionField(position.id, "_slHandledAt", Date.now()); } catch {}
            toClose.push({ positionId: position.id, code: "SL", reason: `hard SL: ${solPnlPct.toFixed(1)}% [sol-fallback]`, pnlPercent: solPnlPct, currentValue });
            continue;
          }
          console.log(`  ⚠️ ${position.id}: PnL unavailable (sol-based=${solPnlPct.toFixed(1)}%, above hardSL ${fallbackHardSL.toFixed(1)}%) — skipping tier 1`);
        }

        if (holdHours >= effectiveMaxHold) {
          toClose.push({ positionId: position.id, code: "MAX_HOLD", reason: `max hold: ${holdHours.toFixed(0)}h${isStrictHours() ? " (strict)" : ""}`, pnlPercent: 0, currentValue });
          continue;
        }
        console.log(`  ⏳ ${position.id}: holding (${holdHours.toFixed(1)}h) — PnL unavailable, skipping exit checks`);
        continue;
      }

      // Persist PnL via in-memory map (avoids race with updatePositionField writers below)
      try {
        const { updatePositionField } = await import("./positionManager.js");
        updatePositionField(position.id, "lastPnlPct",    parseFloat(pnlPercent.toFixed(2)));
        updatePositionField(position.id, "lastPnlSource", pnlSource);
        updatePositionField(position.id, "lastChecked",   new Date().toISOString());
      } catch(e) {}

      // ── OOR check with 30-min grace period ───────────────────────────────
      try {
        const { getPositionBinStatus, updatePositionField } = await import("./positionManager.js");
        const binStatus = await getPositionBinStatus(position.id);

        if (binStatus && binStatus.outOfRange) {
          const oorSince = position.oorSince;
          if (!oorSince) {
            updatePositionField(position.id, 'oorSince', new Date().toISOString());
            console.log(`  ⏱️ ${position.id}: OOR detected (active=${binStatus.activeBinId} range=[${binStatus.lowerBin}-${binStatus.upperBin}]) — evaluating momentum...`);
          } else {
            const minutesOOR = (Date.now() - new Date(oorSince).getTime()) / 60_000;

            // Smart OOR: use on-chain direction (more accurate than price API)
            let oorWaitMinutes = config.outOfRangeWaitMinutes; // default 30
            const oorDir = binStatus.oorDirection; // "right" = pump, "left" = dump
            const strict = isStrictHours();
            if (oorDir === "right") {
              // Token pumped past range → position is all-token, value up, no IL
              const rStrict = Number(process.env.OOR_RIGHT_STRICT_MIN) || 15;
              const rNormal = Number(process.env.OOR_RIGHT_NORMAL_MIN) || 35;
              oorWaitMinutes = strict ? rStrict : rNormal;
              console.log(`  [OOR] kanan — token pump (active=${binStatus.activeBinId} > upper=${binStatus.upperBin}), wait ${oorWaitMinutes}m${strict ? " (strict)" : ""}`);
            } else if (oorDir === "left") {
              // Token dumped below range → position is all-SOL, IL realized
              const lStrict = Number(process.env.OOR_LEFT_STRICT_MIN) || 10;
              const lNormal = Number(process.env.OOR_LEFT_NORMAL_MIN) || 15;
              oorWaitMinutes = strict ? lStrict : lNormal;
              console.log(`  [OOR] kiri — token dump (active=${binStatus.activeBinId} < lower=${binStatus.lowerBin}), close in ${oorWaitMinutes}m${strict ? " (strict)" : ""}`);
            }
            updatePositionField(position.id, 'oorDirection', oorDir);

            if (minutesOOR >= oorWaitMinutes) {
              // ── Rebalance option: if token still bullish, rebalance instead of close
              let rebalanced = false;
              try {
                const rebalanceCount = position.rebalanceCount ?? 0;
                // Only rebalance on OOR right (token pump) — OOR left = dump, just close
                const shouldRebalance = oorDir === "right";

                if (shouldRebalance && rebalanceCount < 2) {
                  console.log(`  [Rebalance] OOR kanan (pump), rebalancing range (attempt ${rebalanceCount + 1}/2)`);
                  try {
                    const { rebalancePosition } = await import("./positionManager.js");
                    const scheduled = await rebalancePosition(position.id);
                    if (scheduled) {
                      rebalanced = true;
                      console.log(`  ✅ [Rebalance] ${position.id} closed, re-open queued (5min, restart-safe)`);
                    }
                  } catch (rebErr) { console.log(`  [Rebalance] failed: ${rebErr.message} — closing instead`); }
                } else if (shouldRebalance) {
                  console.log(`  [Rebalance] max rebalances (${rebalanceCount}) reached — closing`);
                }
              } catch (e) { console.warn(`  ⚠️ Rebalance check error: ${e.message}`); }

              if (!rebalanced) {
              console.log(`  🚨 ${position.id}: OOR ${minutesOOR.toFixed(0)}m+ (wait=${oorWaitMinutes}m) AUTO-CLOSING (active=${binStatus.activeBinId} range=[${binStatus.lowerBin}-${binStatus.upperBin}])`);
              toClose.push({ positionId: position.id, code: oorDir === "left" ? "OOR_LEFT" : "OOR_RIGHT", reason: `out of range ${oorDir ?? "?"} ${minutesOOR.toFixed(0)}m (wait=${oorWaitMinutes}m)`, pnlPercent, currentValue });
              }
              continue;
            } else {
              const remaining = (oorWaitMinutes - minutesOOR).toFixed(0);
              console.log(`  ⏱️ ${position.id}: OOR for ${minutesOOR.toFixed(0)}m, waiting ${remaining}m more (limit=${oorWaitMinutes}m)...`);
            }
          }
        } else if (binStatus) {
          if (position.oorSince) {
            const { updatePositionField } = await import("./positionManager.js");
            updatePositionField(position.id, 'oorSince', null);
            console.log(`  ✅ ${position.id}: back in range — OOR timer cleared`);
          }

          // ── Fee take-profit (only check when in range) ──────────────────
          if (binStatus.totalFeeSol > 0 && position.solDeployed > 0) {
            const feePct = binStatus.totalFeeSol / position.solDeployed;
            if (feePct >= config.takeProfitFeePct) {
              console.log(`  💰 ${position.id}: Fee TP: ${binStatus.totalFeeSol.toFixed(4)} SOL fees (${(feePct * 100).toFixed(1)}%)`);
              toClose.push({ positionId: position.id, code: "FEE_TP", reason: `fee take-profit: ${(feePct * 100).toFixed(1)}%`, pnlPercent, currentValue });
              continue;
            }
          }
        }
      } catch (e) {
        console.warn(`  ⚠️ OOR/fee check failed for ${position.id}:`, e.message);
      }

      // ── Stop loss — severity-tiered (3 tiers) ─────────────────────────────
      // Tier 3 (panic, ≤2.5x normal SL): instant close, no checks
      // Tier 2 (hard,  ≤1.7x normal SL): instant close, no waiting (catches fast crashes)
      // Tier 1 (normal, ≤1x): 2-consecutive-reading confirmation + smart glitch detector
      //
      // The old "swing > 15% = bad data, skip" guard was REMOVED at tiers 2/3 because
      // it caused SL to no-op during real fast dumps. At tier 1 it's replaced with a
      // smart detector that compares PnL delta vs underlying USD value delta — true
      // RPC glitches change the PnL number without moving the underlying value.
      //
      // Each successful SL push stamps `_slHandledAt` so overlapping healer cycles
      // skip positions already queued for close (prevents double-close race).
      const effectiveSL = isStrictHours() ? -4 : EXIT_RULES.stopLossPercent;  // -6
      const hardSL  = effectiveSL * 1.7;   // ~-10  (~-7 strict)
      const panicSL = effectiveSL * 2.5;   // ~-15  (~-10 strict)

      const { updatePositionField: ufSL } = await import("./positionManager.js");

      if (pnlPercent <= panicSL) {
        // Tier 3 — no checks, no confirmation, close immediately
        console.log(`  💀 ${position.id}: PANIC SL ${pnlPercent.toFixed(1)}% (≤${panicSL.toFixed(1)}%) — closing immediately`);
        ufSL(position.id, "_slHandledAt", Date.now());
        toClose.push({ positionId: position.id, code: "SL", reason: `panic SL: ${pnlPercent.toFixed(1)}% [${pnlSource}]`, pnlPercent, currentValue });
        continue;
      }

      if (pnlPercent <= hardSL) {
        // Tier 2 — instant close, no waiting (fast crashes never get a 2-tick chance)
        console.log(`  🛑 ${position.id}: HARD SL ${pnlPercent.toFixed(1)}% (≤${hardSL.toFixed(1)}%) — closing (no wait)`);
        ufSL(position.id, "_slHandledAt", Date.now());
        toClose.push({ positionId: position.id, code: "SL", reason: `hard SL: ${pnlPercent.toFixed(1)}% [${pnlSource}]`, pnlPercent, currentValue });
        continue;
      }

      if (pnlPercent <= effectiveSL) {
        // Tier 1 (noise zone -6% to -10%) — require 2 consecutive readings + smart glitch check
        const prevPnl = position._prevPnlPercent ?? null;
        const lastVal = position._lastPosValueUsd ?? null;
        const currVal = position._posValueUsd ?? null;

        ufSL(position.id, "_prevPnlPercent", pnlPercent);
        if (currVal != null) ufSL(position.id, "_lastPosValueUsd", currVal);

        // Smart glitch detector: PnL changed sharply but underlying USD value didn't
        // move directionally consistent → true RPC glitch (PnL number wandered without
        // the position actually moving). Only applied at tier 1, never at tier 2/3.
        let isGlitch = false;
        if (prevPnl !== null && lastVal !== null && currVal !== null && lastVal > 0 && Math.abs(pnlPercent - prevPnl) > 15) {
          const pnlDeltaSign = Math.sign(pnlPercent - prevPnl);
          const valDeltaSign = Math.sign(currVal - lastVal);
          const valChangeAbs = Math.abs((currVal - lastVal) / lastVal);
          // Glitch if: PnL moved one way while value moved opposite, OR value barely moved (<0.5%)
          isGlitch = (pnlDeltaSign !== 0 && pnlDeltaSign !== valDeltaSign) || valChangeAbs < 0.005;
        }

        if (isGlitch) {
          console.log(`  ⚠️ ${position.id}: PnL swing ${prevPnl.toFixed(1)}%→${pnlPercent.toFixed(1)}% but value $${lastVal.toFixed(0)}→$${currVal.toFixed(0)} (no real move) — RPC glitch, skipping SL`);
        } else if (prevPnl !== null && prevPnl <= effectiveSL) {
          console.log(`  🛑 ${position.id}: SL confirmed (prev=${prevPnl.toFixed(1)}% now=${pnlPercent.toFixed(1)}%)`);
          ufSL(position.id, "_slHandledAt", Date.now());
          toClose.push({ positionId: position.id, code: "SL", reason: `stop loss: ${pnlPercent.toFixed(1)}% [${pnlSource}]`, pnlPercent, currentValue });
          continue;
        } else {
          console.log(`  ⚠️ ${position.id}: SL triggered ${pnlPercent.toFixed(1)}% — waiting for confirmation next cycle`);
        }
      } else {
        // Above SL — reset trackers
        try {
          ufSL(position.id, "_prevPnlPercent", pnlPercent);
          if (position._posValueUsd != null) ufSL(position.id, "_lastPosValueUsd", position._posValueUsd);
        } catch {}
      }

      // ── Static Take Profit (runs BEFORE trailing TP) ──────────────────────
      // Closes immediately when PnL hits TAKE_PROFIT_PERCENT (default 8%).
      // Upper cap <= 90 guards against bad-data false-positives (e.g. RPC glitch
      // claiming impossible gains). Runs before trailing TP so the static target
      // always wins when both conditions fire on the same cycle — trailing TP
      // still activates earlier at TRAILING_TP_ACTIVATION (6%, 4% strict) and
      // handles the 6-8% band where static hasn't triggered yet.
      if (pnlPercent >= EXIT_RULES.takeProfitPercent && pnlPercent <= 90) {
        console.log(`  💰 ${position.id}: TAKE PROFIT hit +${pnlPercent.toFixed(1)}% (≥${EXIT_RULES.takeProfitPercent}%) — closing`);
        toClose.push({ positionId: position.id, code: "TP", reason: `take profit: +${pnlPercent.toFixed(1)}% [${pnlSource}]`, pnlPercent, currentValue });
        continue;
      }

      // ── Trailing Take Profit ──────────────────────────────────────────────
      // Activates at TRAILING_TP_ACTIVATION%, then tracks highWaterMark.
      // Closes when PnL drops TRAILING_TP_TRAIL% from HWM.
      try {
        const strict = isStrictHours();
        const trailActivation = strict ? 4 : (config.trailingTpActivation ?? 6);
        const trailDrop = strict ? 1 : (config.trailingTpTrail ?? 2);
        const { updatePositionField: ufTrail } = await import("./positionManager.js");

        // Activate trailing when PnL first reaches activation threshold
        if (!position.trailingActive && pnlPercent >= trailActivation) {
          ufTrail(position.id, "trailingActive", true);
          ufTrail(position.id, "highWaterMark", pnlPercent);
          ufTrail(position.id, "trailingActivatedAt", new Date().toISOString());
          position.trailingActive = true;
          position.highWaterMark = pnlPercent;
          console.log(`  🎯 [TrailingTP] ACTIVATED at +${pnlPercent.toFixed(2)}% (trail=${trailDrop}%)`);
          try {
            const { notifyMessage: nMsg, esc: escFn } = await import("./telegramBot.js");
            const lock = (pnlPercent - trailDrop).toFixed(2);
            await nMsg(`🎯 <b>Trailing TP aktif!</b>\n\nPool: ${escFn(position.poolName ?? position.id)}\nPnL: <b>+${pnlPercent.toFixed(2)}%</b>\nHWM: +${pnlPercent.toFixed(2)}%\nLock: +${lock}%`);
          } catch {}
        }

        if (position.trailingActive) {
          // Update high water mark
          if (pnlPercent > (position.highWaterMark ?? 0)) {
            ufTrail(position.id, "highWaterMark", pnlPercent);
            position.highWaterMark = pnlPercent;
            console.log(`  🎯 [TrailingTP] new HWM=+${pnlPercent.toFixed(2)}%`);
          }

          const hwm = position.highWaterMark ?? 0;
          const dropFromHigh = hwm - pnlPercent;
          const lockPct = (hwm - trailDrop).toFixed(2);

          // Trigger close if PnL dropped trail amount from HWM
          if (dropFromHigh >= trailDrop) {
            console.log(`  🏁 [TrailingTP] TRIGGERED: HWM=+${hwm.toFixed(2)}% exit=+${pnlPercent.toFixed(2)}% lock=+${lockPct}%`);
            toClose.push({ positionId: position.id, code: "TRAILING_TP", reason: `trailing TP: HWM +${hwm.toFixed(1)}% → +${pnlPercent.toFixed(1)}% (drop ${dropFromHigh.toFixed(1)}%)`, pnlPercent, currentValue });
            continue;
          } else {
            console.log(`  🎯 [TrailingTP] HWM=+${hwm.toFixed(2)}% now=+${pnlPercent.toFixed(2)}% lock=+${lockPct}% → holding`);
          }
        }
      } catch (e) { console.warn(`  ⚠️ TrailingTP error:`, e.message); }

      // ── Max hold time ─────────────────────────────────────────────────────
      if (holdHours >= effectiveMaxHold) {
        toClose.push({ positionId: position.id, code: "MAX_HOLD", reason: `max hold: ${holdHours.toFixed(0)}h${isStrictHours() ? " (strict 2h)" : ""}`, pnlPercent, currentValue });
        continue;
      }

      // ── Fee APR floor ─────────────────────────────────────────────────────
      if (getPoolData) {
        const poolData = await getPoolData(position.pool).catch(() => null);
        if (poolData) {
          const apr = poolData?.feeApr ?? 0;
          if (apr > 0 && apr < EXIT_RULES.minFeeAprToHold) {
            toClose.push({ positionId: position.id, code: "FEE_APR_FLOOR", reason: `fee APR too low: ${apr.toFixed(1)}%`, pnlPercent, currentValue });
            continue;
          }
        }
      }

      console.log(`  ⏳ ${position.id}: holding (${holdHours.toFixed(1)}h) — no exit condition met`);
    } catch (err) {
      console.warn(`  ⚠️ Could not evaluate exit for ${position.id}:`, err.message);
    }
  }

  return toClose;
}

function checkTakeProfit(position, currentValue) {
  const pnlPercent = ((currentValue - position.solDeployed) / position.solDeployed) * 100;
  if (pnlPercent >= EXIT_RULES.takeProfitPercent && pnlPercent <= 90) {
    return { shouldExit: true, reason: `take profit hit: +${pnlPercent.toFixed(1)}%`, pnlPercent };
  }
  return { shouldExit: false };
}

function checkStopLoss(position, currentValue) {
  const pnlPercent = ((currentValue - position.solDeployed) / position.solDeployed) * 100;
  if (pnlPercent <= EXIT_RULES.stopLossPercent) {
    return { shouldExit: true, reason: `stop loss hit: ${pnlPercent.toFixed(1)}%`, pnlPercent };
  }
  return { shouldExit: false };
}

function checkMaxHoldTime(position) {
  const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / 3_600_000;
  const maxHold = isStrictHours() ? 2 : EXIT_RULES.maxHoldHours;
  if (holdHours >= maxHold) {
    return { shouldExit: true, reason: `max hold time: ${holdHours.toFixed(0)}h${isStrictHours() ? " (strict)" : ""}`, holdHours };
  }
  return { shouldExit: false };
}
