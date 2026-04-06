// src-vps/thresholdEvolver.js
// Auto-evolve filter thresholds based on trade performance
// Runs after each position close, evolves every 10 trades

import fs from "fs";
import path from "path";

const ENV_FILE = path.resolve(".env");
const BRAIN_FILE = path.resolve("data/agent_brain.json");
const RUNS_FILE = path.resolve("data/hunter_runs_no_open.json");

const MIN_TRADES_TO_EVOLVE = 10;

// Hard caps — thresholds cannot go beyond these
const DEFAULTS = {
  MIN_POOL_FEE_APR: 1.0,
  MIN_POOL_VOLUME_USD: 100000,
};
const CAPS = {
  MIN_POOL_FEE_APR:     { min: 0.5, max: 2.0 },
  MIN_POOL_VOLUME_USD:  { min: 50000, max: 500000 },
};

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
  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) result.push(`${key}=${val}`);
  }
  fs.writeFileSync(ENV_FILE, result.join("\n"), "utf-8");
}

function clamp(key, value) {
  const cap = CAPS[key];
  if (!cap) return value;
  return Math.max(cap.min, Math.min(cap.max, value));
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
    console.log("[EVOLVE] Brain log error:", e.message);
  }
}

// ── Track consecutive hunter runs with no opens ─────────────────────
function loadNoOpenRuns() {
  try { return JSON.parse(fs.readFileSync(RUNS_FILE, "utf-8")).count ?? 0; } catch { return 0; }
}
function saveNoOpenRuns(count) {
  try {
    fs.mkdirSync(path.dirname(RUNS_FILE), { recursive: true });
    fs.writeFileSync(RUNS_FILE, JSON.stringify({ count, updatedAt: new Date().toISOString() }));
  } catch {}
}

export function recordHunterRunResult(openedPosition) {
  if (openedPosition) {
    saveNoOpenRuns(0);
  } else {
    const current = loadNoOpenRuns();
    saveNoOpenRuns(current + 1);

    if (current + 1 >= 5) {
      console.log(`[EVOLVE] No positions in ${current + 1} runs → resetting to defaults`);
      const { lines } = readEnv();
      const resets = {};
      for (const [key, val] of Object.entries(DEFAULTS)) {
        resets[key] = val;
      }
      writeEnv(lines, resets);
      saveNoOpenRuns(0);
      logEvolutionToBrain({ action: "reset-to-defaults", reason: `${current + 1} consecutive runs with no opens` });
    }
  }
}

/**
 * Called after each position close. Evolves thresholds every 10 trades.
 */
export function maybeEvolveThresholds(stats) {
  if (!stats || (stats.totalTrades ?? 0) < MIN_TRADES_TO_EVOLVE) return;
  if (stats.totalTrades % 10 !== 0) return;

  const { lines, obj } = readEnv();

  const winRate = parseFloat(stats.hitRate ?? 0);
  const avgPnl  = parseFloat(stats.avgPnlPercent ?? 0);

  const currentFeeApr = parseFloat(obj.MIN_POOL_FEE_APR ?? DEFAULTS.MIN_POOL_FEE_APR);
  const currentVolume = parseFloat(obj.MIN_POOL_VOLUME_USD ?? DEFAULTS.MIN_POOL_VOLUME_USD);

  const changes = {};
  const reasons = [];

  if (winRate < 40) {
    const newVal = clamp("MIN_POOL_FEE_APR", parseFloat((currentFeeApr * 1.05).toFixed(2)));
    if (newVal !== currentFeeApr) {
      changes.MIN_POOL_FEE_APR = newVal;
      reasons.push(`WR ${winRate.toFixed(1)}% < 40% → feeApr=${currentFeeApr}→${newVal}`);
    }
  }

  if (avgPnl < -3) {
    const newVal = clamp("MIN_POOL_VOLUME_USD", Math.round(currentVolume * 1.10));
    if (newVal !== currentVolume) {
      changes.MIN_POOL_VOLUME_USD = newVal;
      reasons.push(`avgPnL ${avgPnl.toFixed(1)}% < -3% → volume=${currentVolume}→${newVal}`);
    }
  }

  if (winRate > 40 && avgPnl > 0) {
    const newFeeApr = clamp("MIN_POOL_FEE_APR", parseFloat((currentFeeApr * 0.97).toFixed(2)));
    if (newFeeApr !== currentFeeApr) {
      changes.MIN_POOL_FEE_APR = newFeeApr;
      reasons.push(`WR ${winRate.toFixed(1)}% > 40% & avgPnL positive → feeApr=${currentFeeApr}→${newFeeApr}`);
    }
  }

  if (Object.keys(changes).length === 0) {
    console.log(`[EVOLVE] No changes at ${stats.totalTrades} trades (WR=${winRate.toFixed(1)}%, avgPnL=${avgPnl.toFixed(1)}%)`);
    return;
  }

  writeEnv(lines, changes);
  logEvolutionToBrain({ changes, reasons, stats: { winRate, avgPnl, totalTrades: stats.totalTrades } });

  console.log(`[EVOLVE] after ${stats.totalTrades} trades: ${reasons.join(" | ")}`);
}
