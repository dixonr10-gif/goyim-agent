import fs from "fs";
import { config } from "../config.js";

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
  takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 10,
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
          toClose.push({ positionId: position.id, reason: "position gone on-chain (external close)", pnlPercent: 0, currentValue: 0 });
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
        // No fallback — usd-precise only. Skip exit checks if price unavailable.
        if (pnlSource === "none") {
          console.log(`  ⚠️ ${position.id}: [PnL] usd-precise unavailable — skipping exit checks this cycle`);
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
      if (pnlSource === "none") {
        if (holdHours >= EXIT_RULES.maxHoldHours) {
          toClose.push({ positionId: position.id, reason: `max hold: ${holdHours.toFixed(0)}h`, pnlPercent: 0, currentValue });
          continue;
        }
        console.log(`  ⏳ ${position.id}: holding (${holdHours.toFixed(1)}h) — PnL unavailable, skipping exit checks`);
        continue;
      }

      // Persist PnL to file
      try {
        const posFile = '/root/goyim-agent/data/open_positions.json';
        const positions = JSON.parse(fs.readFileSync(posFile, 'utf8'));
        if (positions[position.id]) {
          positions[position.id].lastPnlPct    = parseFloat(pnlPercent.toFixed(2));
          positions[position.id].lastPnlSource = pnlSource;
          positions[position.id].lastChecked   = new Date().toISOString();
          fs.writeFileSync(posFile, JSON.stringify(positions, null, 2));
        }
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
            if (oorDir === "right") {
              // Token pumped past range → position is all-token, value up, no IL
              oorWaitMinutes = 60;
              console.log(`  [OOR] kanan — token pump (active=${binStatus.activeBinId} > upper=${binStatus.upperBin}), extend wait 60m`);
            } else if (oorDir === "left") {
              // Token dumped below range → position is all-SOL, IL realized
              oorWaitMinutes = 15;
              console.log(`  [OOR] kiri — token dump (active=${binStatus.activeBinId} < lower=${binStatus.lowerBin}), close in 15m`);
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
                    const { rebalancePosition, updatePositionField } = await import("./positionManager.js");
                    const newPosId = await rebalancePosition(position.id);
                    if (newPosId) {
                      updatePositionField(newPosId, "rebalanceCount", rebalanceCount + 1);
                      updatePositionField(newPosId, "rebalancedFrom", position.id);
                      rebalanced = true;
                      console.log(`  ✅ [Rebalance] ${position.id} → ${newPosId}`);
                    }
                  } catch (rebErr) { console.log(`  [Rebalance] failed: ${rebErr.message} — closing instead`); }
                } else if (shouldRebalance) {
                  console.log(`  [Rebalance] max rebalances (${rebalanceCount}) reached — closing`);
                }
              } catch (e) { console.warn(`  ⚠️ Rebalance check error: ${e.message}`); }

              if (!rebalanced) {
              console.log(`  🚨 ${position.id}: OOR ${minutesOOR.toFixed(0)}m+ (wait=${oorWaitMinutes}m) AUTO-CLOSING (active=${binStatus.activeBinId} range=[${binStatus.lowerBin}-${binStatus.upperBin}])`);
              toClose.push({ positionId: position.id, reason: `out of range ${minutesOOR.toFixed(0)}m (wait=${oorWaitMinutes}m)`, pnlPercent, currentValue });
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
              toClose.push({ positionId: position.id, reason: `fee take-profit: ${(feePct * 100).toFixed(1)}%`, pnlPercent, currentValue });
              continue;
            }
          }
        }
      } catch (e) {
        console.warn(`  ⚠️ OOR/fee check failed for ${position.id}:`, e.message);
      }

      // ── Stop loss (requires 2 consecutive negative readings to avoid bad data) ──
      if (pnlPercent <= EXIT_RULES.stopLossPercent) {
        const prevPnl = position._prevPnlPercent ?? null;
        const { updatePositionField: ufSL } = await import("./positionManager.js");
        ufSL(position.id, "_prevPnlPercent", pnlPercent);

        // Sanity check: if PnL swung more than 15% from last reading, likely bad data → skip
        if (prevPnl !== null && Math.abs(pnlPercent - prevPnl) > 15) {
          console.log(`  ⚠️ ${position.id}: PnL swing ${prevPnl.toFixed(1)}%→${pnlPercent.toFixed(1)}% (${Math.abs(pnlPercent - prevPnl).toFixed(0)}% delta) — likely bad data, skipping SL`);
        } else if (prevPnl !== null && prevPnl <= EXIT_RULES.stopLossPercent) {
          // 2 consecutive SL readings — confirmed loss
          console.log(`  🛑 ${position.id}: SL confirmed (prev=${prevPnl.toFixed(1)}% now=${pnlPercent.toFixed(1)}%)`);
          toClose.push({ positionId: position.id, reason: `stop loss: ${pnlPercent.toFixed(1)}% [${pnlSource}]`, pnlPercent, currentValue });
          continue;
        } else {
          console.log(`  ⚠️ ${position.id}: SL triggered ${pnlPercent.toFixed(1)}% — waiting for confirmation next cycle`);
        }
      } else {
        // Reset previous PnL tracker when above SL
        try { const { updatePositionField: ufReset } = await import("./positionManager.js"); ufReset(position.id, "_prevPnlPercent", pnlPercent); } catch {}
      }

      // ── Take profit (fixed) ────────────────────────────────────────────────
      // NOTE: fixed TP is now only a fallback; trailing TP below handles the smart exit
      // If trailing is already active, skip the fixed TP — let trailing manage it
      if (pnlPercent >= EXIT_RULES.takeProfitPercent && !position.trailingHigh) {
        // Activate trailing instead of closing immediately
        try {
          const { updatePositionField } = await import("./positionManager.js");
          updatePositionField(position.id, "trailingHigh", pnlPercent);
          position.trailingHigh = pnlPercent;
          console.log(`  [TrailingTP] ACTIVATED at ${pnlPercent.toFixed(1)}% — watching for pullback`);
        } catch {}
      }

      // ── Trailing take profit ──────────────────────────────────────────────
      try {
        if (position.trailingHigh != null) {
          const { updatePositionField } = await import("./positionManager.js");
          if (pnlPercent > position.trailingHigh) {
            updatePositionField(position.id, "trailingHigh", pnlPercent);
            position.trailingHigh = pnlPercent;
            console.log(`  [TrailingTP] new high=${pnlPercent.toFixed(1)}% → watching`);
          }
          const dropFromHigh = position.trailingHigh - pnlPercent;
          if (position.trailingHigh >= EXIT_RULES.takeProfitPercent && dropFromHigh >= 4) {
            console.log(`  [TrailingTP] TRIGGERED: high=${position.trailingHigh.toFixed(1)}% dropped to ${pnlPercent.toFixed(1)}%`);
            toClose.push({ positionId: position.id, reason: `trailing TP: high=${position.trailingHigh.toFixed(1)}% dropped to ${pnlPercent.toFixed(1)}%`, pnlPercent, currentValue });
            continue;
          } else {
            console.log(`  [TrailingTP] high=${position.trailingHigh.toFixed(1)}% current=${pnlPercent.toFixed(1)}% drop=${dropFromHigh.toFixed(1)}% → watching`);
          }
        }
      } catch (e) { console.warn(`  ⚠️ TrailingTP error:`, e.message); }

      // ── Max hold time ─────────────────────────────────────────────────────
      if (holdHours >= EXIT_RULES.maxHoldHours) {
        toClose.push({ positionId: position.id, reason: `max hold: ${holdHours.toFixed(0)}h`, pnlPercent, currentValue });
        continue;
      }

      // ── Fee APR floor ─────────────────────────────────────────────────────
      if (getPoolData) {
        const poolData = await getPoolData(position.pool).catch(() => null);
        if (poolData) {
          const apr = poolData?.feeApr ?? 0;
          if (apr > 0 && apr < EXIT_RULES.minFeeAprToHold) {
            toClose.push({ positionId: position.id, reason: `fee APR too low: ${apr.toFixed(1)}%`, pnlPercent, currentValue });
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
  if (holdHours >= EXIT_RULES.maxHoldHours) {
    return { shouldExit: true, reason: `max hold time: ${holdHours.toFixed(0)}h`, holdHours };
  }
  return { shouldExit: false };
}
