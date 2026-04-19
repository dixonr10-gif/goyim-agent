// src-vps/dailyCircuitBreaker.js
// Daily realized-PnL circuit breaker. Resets at 00:00 WIB; pauses Hunter +
// pending re-opens when realized USD PnL hits +PROFIT_TARGET or -LOSS_LIMIT.
//
// Persisted to data/daily_pnl_tracker.json so state survives PM2 restarts.
// Portfolio formula: walletSol + Σ(open position solDeployed). This captures
// realized PnL (closes return wallet growth; opens cancel out); unrealized PnL
// on still-open positions is intentionally excluded.

import fs from "fs";
import path from "path";
import { checkWalletBalance, getOpenPositions, fetchSolPriceUsd } from "./positionManager.js";

const FILE = path.resolve("data/daily_pnl_tracker.json");
const PROFIT_TARGET_USD = Number(process.env.DAILY_PROFIT_TARGET_USD) || 150;
const LOSS_LIMIT_USD    = Number(process.env.DAILY_LOSS_LIMIT_USD)    || -100;
const MAX_CHECK_LOG = 10;

let _state = null;

function load() {
  try {
    if (fs.existsSync(FILE)) return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch (e) { console.warn("[CircuitBreaker] load error:", e.message); }
  return null;
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error("[CircuitBreaker] save error:", e.message); }
}

function getWibDate(now = new Date()) {
  const wib = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const y = wib.getUTCFullYear();
  const m = String(wib.getUTCMonth() + 1).padStart(2, "0");
  const d = String(wib.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function getTotalPortfolioSol() {
  let walletSol = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const b = await checkWalletBalance();
      if (typeof b === "number" && b >= 0) { walletSol = b; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  const deployed = getOpenPositions()
    .filter(p => p && !p.mock)
    .reduce((s, p) => s + (Number(p.solDeployed) || 0), 0);
  return { walletSol, deployedSol: deployed, totalSol: walletSol + deployed };
}

async function safeSolPrice(fallback) {
  try {
    const p = await fetchSolPriceUsd();
    if (typeof p === "number" && p > 10) return { price: p, ok: true };
  } catch {}
  return { price: fallback || 0, ok: false };
}

async function notify(html) {
  try {
    const { notifyMessage } = await import("./telegramBot.js");
    await notifyMessage(html);
  } catch (e) { console.warn("[CircuitBreaker] notify failed:", e.message); }
}

export function isPaused() {
  const s = _state ?? load();
  if (!s) return false;
  // Auto-rollover on new WIB day — clear paused if the day changed but don't
  // touch the baseline here (resetDaily is the single source for baseline).
  if (s.date !== getWibDate()) return false;
  return s.pauseReason != null;
}

export function getPauseReason() {
  const s = _state ?? load();
  if (!s || s.date !== getWibDate()) return null;
  return s.pauseReason;
}

export async function resetDaily({ silent = false } = {}) {
  const portfolio = await getTotalPortfolioSol();
  const prevPrice = _state?.baselineSolPrice || _state?.lastSolPrice || 0;
  const { price: solPrice, ok: priceOk } = await safeSolPrice(prevPrice);
  const baselineUsd = portfolio.totalSol * solPrice;

  _state = {
    date: getWibDate(),
    baselineSol: portfolio.totalSol,
    baselineWalletSol: portfolio.walletSol,
    baselineDeployedSol: portfolio.deployedSol,
    baselineSolPrice: solPrice,
    baselineUsdValue: baselineUsd,
    paused: false,
    pauseReason: null,
    pauseTriggeredAt: null,
    lastCheckAt: new Date().toISOString(),
    lastCheckDeltaUsd: 0,
    lastSolPrice: solPrice,
    checks: [],
  };
  save(_state);

  console.log(`[CircuitBreaker] RESET ${_state.date} WIB — baseline ${portfolio.totalSol.toFixed(4)} SOL @ $${solPrice.toFixed(2)} = $${baselineUsd.toFixed(2)}`);

  if (!silent) {
    await notify(
      `🔄 <b>DAILY RESET (00:00 WIB)</b>\n` +
      `Baseline: ${portfolio.totalSol.toFixed(4)} SOL ($${baselineUsd.toFixed(2)})\n` +
      `SOL Price: $${solPrice.toFixed(2)}${priceOk ? "" : " (cached)"}\n` +
      `Circuit breaker ACTIVE\n` +
      `Profit target: +$${PROFIT_TARGET_USD} | Loss limit: $${LOSS_LIMIT_USD}`
    );
  }
  return _state;
}

export async function initDailyCircuitBreaker() {
  const saved = load();
  const today = getWibDate();

  if (!saved) {
    console.log("[CircuitBreaker] no prior state — initializing baseline");
    await resetDaily({ silent: true });
    console.log(`[CircuitBreaker] Initialized (baseline $${_state.baselineUsdValue.toFixed(2)})`);
    return _state;
  }

  if (saved.date !== today) {
    console.log(`[CircuitBreaker] stored date ${saved.date} != today ${today} — reset`);
    _state = saved;
    await resetDaily();
    return _state;
  }

  _state = saved;
  const status = _state.pauseReason ? `PAUSED (${_state.pauseReason})` : "ACTIVE";
  console.log(`[CircuitBreaker] Initialized from file — date=${_state.date} status=${status} baseline=$${_state.baselineUsdValue.toFixed(2)}`);
  return _state;
}

export async function checkCircuitBreaker({ silent = false } = {}) {
  if (!_state) _state = load();
  if (!_state) { await initDailyCircuitBreaker(); }

  // Day-rollover takes priority — resetDaily will overwrite _state
  if (_state.date !== getWibDate()) {
    await resetDaily();
    return _state;
  }

  const portfolio = await getTotalPortfolioSol();
  const { price: solPrice, ok: priceOk } = await safeSolPrice(_state.baselineSolPrice);
  const currentUsd = portfolio.totalSol * solPrice;
  const deltaUsd = currentUsd - _state.baselineUsdValue;
  const deltaSol = portfolio.totalSol - _state.baselineSol;

  const wibTime = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16);
  const check = {
    timestamp: new Date().toISOString(),
    wibTime,
    totalSol: Number(portfolio.totalSol.toFixed(6)),
    solPrice: Number(solPrice.toFixed(4)),
    deltaSol: Number(deltaSol.toFixed(6)),
    deltaUsd: Number(deltaUsd.toFixed(2)),
    triggered: false,
    priceOk,
  };

  _state.checks = [...(_state.checks || []), check].slice(-MAX_CHECK_LOG);
  _state.lastCheckAt = check.timestamp;
  _state.lastCheckDeltaUsd = check.deltaUsd;
  _state.lastSolPrice = solPrice;

  console.log(`[CircuitBreaker] check ${wibTime} WIB — delta=$${deltaUsd.toFixed(2)} (${deltaSol >= 0 ? "+" : ""}${deltaSol.toFixed(4)} SOL) status=${_state.pauseReason ? "PAUSED" : "ACTIVE"}${priceOk ? "" : " [price-cached]"}`);

  if (_state.pauseReason) {
    save(_state);
    return _state;
  }

  let triggered = null;
  if (deltaUsd >= PROFIT_TARGET_USD) triggered = "PROFIT_TARGET";
  else if (deltaUsd <= LOSS_LIMIT_USD) triggered = "LOSS_LIMIT";

  if (triggered) {
    check.triggered = true;
    _state.paused = true;
    _state.pauseReason = triggered;
    _state.pauseTriggeredAt = check.timestamp;
    save(_state);

    const header = triggered === "PROFIT_TARGET"
      ? "🎯 <b>DAILY PROFIT TARGET HIT</b>"
      : "🛑 <b>DAILY LOSS LIMIT HIT</b>";
    await notify(
      `${header}\n` +
      `Delta: ${deltaUsd >= 0 ? "+" : ""}$${deltaUsd.toFixed(2)} (${deltaSol >= 0 ? "+" : ""}${deltaSol.toFixed(4)} SOL)\n` +
      `Baseline: ${_state.baselineSol.toFixed(4)} SOL ($${_state.baselineUsdValue.toFixed(2)})\n` +
      `Current: ${portfolio.totalSol.toFixed(4)} SOL ($${currentUsd.toFixed(2)})\n` +
      `SOL Price: $${solPrice.toFixed(2)}\n` +
      `Hunter PAUSED until 00:00 WIB.\n` +
      `Open positions tetap di-manage.`
    );
  } else {
    save(_state);
  }

  return _state;
}

export async function manualPause(reason = "MANUAL") {
  if (!_state) _state = load() ?? (await initDailyCircuitBreaker());
  if (_state.date !== getWibDate()) await resetDaily();
  _state.paused = true;
  _state.pauseReason = reason;
  _state.pauseTriggeredAt = new Date().toISOString();
  save(_state);
  console.log(`[CircuitBreaker] MANUAL PAUSE (${reason})`);
  return _state;
}

export async function manualResume() {
  if (!_state) _state = load() ?? (await initDailyCircuitBreaker());
  if (_state.date !== getWibDate()) await resetDaily();
  _state.paused = false;
  _state.pauseReason = null;
  _state.pauseTriggeredAt = null;
  save(_state);
  console.log("[CircuitBreaker] MANUAL RESUME (baseline unchanged)");
  return _state;
}

export async function getDailyStatus() {
  if (!_state) _state = load() ?? (await initDailyCircuitBreaker());
  if (_state.date !== getWibDate()) await resetDaily();

  const portfolio = await getTotalPortfolioSol();
  const { price: solPrice, ok: priceOk } = await safeSolPrice(_state.baselineSolPrice);
  const currentUsd = portfolio.totalSol * solPrice;
  const deltaUsd = currentUsd - _state.baselineUsdValue;
  const deltaSol = portfolio.totalSol - _state.baselineSol;

  return {
    date: _state.date,
    paused: !!_state.pauseReason,
    pauseReason: _state.pauseReason,
    pauseTriggeredAt: _state.pauseTriggeredAt,
    baselineSol: _state.baselineSol,
    baselineSolPrice: _state.baselineSolPrice,
    baselineUsdValue: _state.baselineUsdValue,
    currentTotalSol: portfolio.totalSol,
    currentSolPrice: solPrice,
    currentSolPriceOk: priceOk,
    currentUsdValue: currentUsd,
    currentDeltaSol: deltaSol,
    currentDeltaUsd: deltaUsd,
    profitTarget: PROFIT_TARGET_USD,
    lossLimit: LOSS_LIMIT_USD,
    lastCheckAt: _state.lastCheckAt,
  };
}

// ── WIB-aligned 6-hour scheduler ──────────────────────────────────────────
// Fires at 00:00, 06:00, 12:00, 18:00 WIB. 00:00 performs resetDaily before
// the check. Per-slot dedupe so repeated 60s ticks within the same minute
// don't trigger twice.
const SCHEDULE_SLOTS = [0, 6, 12, 18]; // WIB hours
let _lastFiredSlotKey = null;

export function startCircuitBreakerScheduler() {
  console.log(`[CircuitBreaker] scheduler started — fires at ${SCHEDULE_SLOTS.map(h => String(h).padStart(2, "0") + ":00").join(", ")} WIB`);
  setInterval(async () => {
    try {
      const nowUtc = new Date();
      const wib = new Date(nowUtc.getTime() + 7 * 60 * 60 * 1000);
      const wibHour = wib.getUTCHours();
      const wibMinute = wib.getUTCMinutes();
      const wibDate = getWibDate(nowUtc);

      if (!SCHEDULE_SLOTS.includes(wibHour) || wibMinute !== 0) return;

      const slotKey = `${wibDate} ${wibHour}`;
      if (_lastFiredSlotKey === slotKey) return;
      _lastFiredSlotKey = slotKey;

      if (wibHour === 0) {
        await resetDaily();
      }
      await checkCircuitBreaker();
    } catch (e) {
      console.warn("[CircuitBreaker] scheduler tick error:", e.message);
    }
  }, 60_000);
}
