// src-vps/thresholdEvolver.js
// Auto-evolve filter thresholds based on trade performance (Meridian feature)
// Runs after each position close when 5+ trades in history

import fs from "fs";
import path from "path";

const ENV_FILE = path.resolve(".env");
const BRAIN_FILE = path.resolve("data/agent_brain.json");
const MIN_TRADES_TO_EVOLVE = 5;

function readEnv() {
  try {
    const raw = fs.readFileSync(ENV_FILE, "utf-8");
    const lines = raw.split("\n");
    const obj = {};
    for (const line of lines) {
      const match = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (match) obj[match[1].trim()] = match[2].trim();
    }
    return { lines, obj };
  } catch {
    return { lines: [], obj: {} };
  }
}

function writeEnv(lines, updates) {
  const updatedKeys = new Set();
  const result = lines.map(line => {
    const match = line.match(/^([^#=\s][^=]*)=/);
    if (match) {
      const key = match[1].trim();
      if (updates[key] !== undefined) {
        updatedKeys.add(key);
        return `${key}=${updates[key]}`;
      }
    }
    return line;
  });
  // Append any new keys that didn't exist
  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) result.push(`${key}=${val}`);
  }
  fs.writeFileSync(ENV_FILE, result.join("\n"), "utf-8");
}

function logEvolutionToBrain(entry) {
  try {
    let brain = {};
    if (fs.existsSync(BRAIN_FILE)) brain = JSON.parse(fs.readFileSync(BRAIN_FILE, "utf-8"));
    if (!Array.isArray(brain.evolutionLog)) brain.evolutionLog = [];
    brain.evolutionLog.push({ at: new Date().toISOString(), ...entry });
    brain.evolutionLog = brain.evolutionLog.slice(-20);
    fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
  } catch (e) {
    console.error("[EVOLVE] Brain log error:", e.message);
  }
}

/**
 * Called after each position close. Reads trade stats and adjusts .env thresholds
 * if performance criteria are met.
 */
export function maybeEvolveThresholds(stats) {
  if (!stats || (stats.totalTrades ?? 0) < MIN_TRADES_TO_EVOLVE) {
    console.log(`[EVOLVE] Skipping — need ${MIN_TRADES_TO_EVOLVE} trades (have ${stats?.totalTrades ?? 0})`);
    return;
  }

  const { lines, obj } = readEnv();

  const winRate = parseFloat(stats.hitRate ?? 0);
  const avgPnl  = parseFloat(stats.avgPnlPercent ?? 0);

  const currentFeeApr = parseFloat(obj.MIN_POOL_FEE_APR ?? 1);
  const currentVolume = parseFloat(obj.MIN_POOL_VOLUME_USD ?? 1000);

  const changes = {};
  const reasons = [];

  if (winRate < 40) {
    // Too many losses → require higher fee APR pools
    const newVal = parseFloat((currentFeeApr * 1.05).toFixed(1));
    changes.MIN_POOL_FEE_APR = newVal;
    reasons.push(`WR ${winRate.toFixed(1)}% < 40% → MIN_POOL_FEE_APR ${currentFeeApr} → ${newVal}`);
  }

  if (avgPnl < -3) {
    // Too negative avg PnL → require higher volume pools (more liquid)
    const newVal = Math.round(currentVolume * 1.10);
    changes.MIN_POOL_VOLUME_USD = newVal;
    reasons.push(`avgPnL ${avgPnl.toFixed(1)}% < -3% → MIN_POOL_VOLUME_USD ${currentVolume} → ${newVal}`);
  }

  if (winRate > 70 && avgPnl > 0) {
    // Performing well → slightly relax fee APR to access more pools
    const newVal = parseFloat((currentFeeApr * 0.97).toFixed(1));
    if (newVal >= 1) {
      changes.MIN_POOL_FEE_APR = newVal;
      reasons.push(`WR ${winRate.toFixed(1)}% > 70% & avgPnL positive → relax MIN_POOL_FEE_APR ${currentFeeApr} → ${newVal}`);
    }
  }

  if (Object.keys(changes).length === 0) {
    console.log(`[EVOLVE] No changes needed (WR=${winRate.toFixed(1)}%, avgPnL=${avgPnl.toFixed(1)}%, trades=${stats.totalTrades})`);
    return;
  }

  writeEnv(lines, changes);
  logEvolutionToBrain({
    changes,
    reasons,
    stats: { winRate, avgPnl, totalTrades: stats.totalTrades },
  });

  console.log(`[EVOLVE] Thresholds evolved (${stats.totalTrades} trades):`);
  for (const r of reasons) console.log(`  ${r}`);
}
