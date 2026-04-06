// src/exitStrategy.js
// Tentukan kapan harus EXIT posisi: take profit, stop loss, time-based

import { config } from "../config.js";
import { checkOutOfRange, calculateIL } from "./positionManager.js";

// ─── Exit thresholds (bisa diconfig) ─────────────────────────────────

const EXIT_RULES = {
  takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT) || 5,   // exit kalau +5%
  stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || -3,      // exit kalau -3%
  maxHoldHours: parseFloat(process.env.MAX_HOLD_HOURS) || 48,            // exit setelah 48 jam
  minFeeAprToHold: parseFloat(process.env.MIN_FEE_APR_TO_HOLD) || 10,   // exit kalau APR < 10%
};

/**
 * Cek apakah posisi harus di-exit
 * @param {Object} position - posisi aktif
 * @param {Object} currentPoolData - data pool terkini
 * @param {number} currentValue - nilai posisi saat ini dalam SOL
 * @returns {{ shouldExit: boolean, reason: string }}
 */
export function shouldExitPosition(position, currentPoolData, currentValue) {
  const checks = [
    checkTakeProfit(position, currentValue),
    checkStopLoss(position, currentValue),
    checkMaxHoldTime(position),
    checkFeeAPRDropped(currentPoolData),
    checkVolatilitySpike(currentPoolData),
  ];

  // Return first exit signal
  const exitSignal = checks.find((c) => c.shouldExit);
  if (exitSignal) return exitSignal;

  return { shouldExit: false, reason: "holding — no exit condition met" };
}

// ─── Individual checks ────────────────────────────────────────────────

function checkTakeProfit(position, currentValue) {
  const pnlPercent = ((currentValue - position.solDeployed) / position.solDeployed) * 100;

  if (pnlPercent >= EXIT_RULES.takeProfitPercent) {
    return {
      shouldExit: true,
      reason: `take profit hit: +${pnlPercent.toFixed(1)}% (target: +${EXIT_RULES.takeProfitPercent}%)`,
      pnlPercent,
    };
  }
  return { shouldExit: false };
}

function checkStopLoss(position, currentValue) {
  const pnlPercent = ((currentValue - position.solDeployed) / position.solDeployed) * 100;

  if (pnlPercent <= EXIT_RULES.stopLossPercent) {
    return {
      shouldExit: true,
      reason: `stop loss hit: ${pnlPercent.toFixed(1)}% (limit: ${EXIT_RULES.stopLossPercent}%)`,
      pnlPercent,
    };
  }
  return { shouldExit: false };
}

function checkMaxHoldTime(position) {
  const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / 3_600_000;

  if (holdHours >= EXIT_RULES.maxHoldHours) {
    return {
      shouldExit: true,
      reason: `max hold time reached: ${holdHours.toFixed(0)}h (limit: ${EXIT_RULES.maxHoldHours}h)`,
      holdHours,
    };
  }
  return { shouldExit: false };
}

function checkFeeAPRDropped(poolData) {
  if (!poolData) return { shouldExit: false };

  const feeApr = poolData.fee_apr ?? 0;
  if (feeApr < EXIT_RULES.minFeeAprToHold) {
    return {
      shouldExit: true,
      reason: `fee APR too low: ${feeApr.toFixed(1)}% (min: ${EXIT_RULES.minFeeAprToHold}%)`,
    };
  }
  return { shouldExit: false };
}

function checkVolatilitySpike(poolData) {
  if (!poolData) return { shouldExit: false };

  // Kalau volatility tiba-tiba sangat tinggi → IL risk meningkat → exit
  const volatility = poolData.volatility ?? null;
  if (volatility && parseFloat(volatility) > 150) {
    return {
      shouldExit: true,
      reason: `extreme volatility spike: ${volatility}% — IL risk too high`,
    };
  }
  return { shouldExit: false };
}

function checkImpermanentLoss(ilData) {
  if (!ilData) return { shouldExit: false };
  // Exit if IL exceeds -8% — price has diverged enough that LP fees won't recover it
  if (parseFloat(ilData.ilPercent) < -8) {
    return {
      shouldExit: true,
      reason: `IL too high: ${ilData.ilPercent}% (price moved ${ilData.priceRatio}x from entry)`,
    };
  }
  return { shouldExit: false };
}

/**
 * Evaluate semua open positions, return mana yang harus ditutup
 * @param {Array} openPositions
 * @param {Function} getPoolData - async fn(poolAddress) → poolData
 * @param {Function} getPositionValue - async fn(position) → currentValueInSOL
 */
export async function evaluateExits(openPositions, getPoolData, getPositionValue) {
  const toClose = [];

  for (const position of openPositions) {
    try {
      const [poolData, currentValue, oorStatus, ilData] = await Promise.all([
        getPoolData(position.pool),
        getPositionValue(position),
        checkOutOfRange(position.id),
        calculateIL(position).catch(() => null),
      ]);

      // OOR: position earns zero fees — rebalance instead of plain close
      if (oorStatus.outOfRange) {
        const lower = oorStatus.binRange?.lower ?? "?";
        const upper = oorStatus.binRange?.upper ?? "?";
        const reason = `out of range: active bin ${oorStatus.activeBinId} is ${oorStatus.direction} range [${lower}–${upper}]`;
        console.log(`📉 OOR for ${position.id}: ${reason}`);
        toClose.push({ positionId: position.id, reason, currentValue, shouldRebalance: true });
        continue;
      }

      // IL check: high price divergence = impermanent loss eroding principal
      if (ilData) {
        const ilCheck = checkImpermanentLoss(ilData);
        if (ilCheck.shouldExit) {
          console.log(`📉 IL exit for ${position.id}: ${ilCheck.reason}`);
          toClose.push({ positionId: position.id, reason: ilCheck.reason, currentValue });
          continue;
        }
        console.log(`  💱 ${position.id}: IL=${ilData.ilPercent}% (price ${ilData.priceRatio}x from entry)`);
      }

      const check = shouldExitPosition(position, poolData, currentValue);

      if (check.shouldExit) {
        console.log(`🚪 Exit signal for ${position.id}: ${check.reason}`);
        toClose.push({
          positionId: position.id,
          reason: check.reason,
          currentValue,
          pnlPercent: check.pnlPercent,
        });
      } else {
        const holdHours = (Date.now() - new Date(position.openedAt).getTime()) / 3_600_000;
        console.log(`  ⏳ ${position.id}: holding (${holdHours.toFixed(1)}h) — ${check.reason}`);
      }
    } catch (err) {
      console.warn(`  ⚠️ Could not evaluate exit for ${position.id}:`, err.message);
    }
  }

  return toClose;
}
