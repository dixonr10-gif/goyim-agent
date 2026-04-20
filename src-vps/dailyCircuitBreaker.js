// src-vps/dailyCircuitBreaker.js
// Advanced circuit breaker (Part 16):
//  • Profit hit ($150) → auto-swap $90 SOL → USDC + pause 8h
//  • Loss hit (-$100)  → pause 12h (no swap)
//  • SOL dump ≤ -7% 24h → close all positions + swap all SOL → USDC + pause indefinite
//
// Persisted to data/daily_pnl_tracker.json so state survives PM2 restarts.
// Portfolio formula: walletSol + Σ(open position solDeployed). Trading-only PnL:
// deltaUsd = (currentTotalSol - baselineSol) × currentSolPrice. SOL USD drift
// is excluded — a SOL price dump with flat SOL quantity doesn't trip the loss
// limit (that's the dump-hedge's job instead).

import fs from "fs";
import path from "path";
import { checkWalletBalance, getOpenPositions, fetchSolPriceUsd, closePosition } from "./positionManager.js";
import { config } from "../config.js";
import { formatWIB } from "./timeHelper.js";

const FILE = path.resolve("data/daily_pnl_tracker.json");
const PROFIT_TARGET_USD = Number(process.env.DAILY_PROFIT_TARGET_USD) || 150;
const LOSS_LIMIT_USD    = Number(process.env.DAILY_LOSS_LIMIT_USD)    || -100;
// Raised from 10 → 20 so the scheduler retains ~60h of 3-hourly checks,
// plenty of headroom for the 24h-ago SOL price lookback used by the dump guard.
const MAX_CHECK_LOG = 20;

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

// Pause is "active" if a reason is set AND (no expiry OR expiry is still in the
// future). Indefinite pause (manual, hedge) has pausedUntil=null — so any null
// means "until manually resumed", not "none".
function isPauseActive(state) {
  if (!state || !state.pauseReason) return false;
  if (state.pausedUntil == null) return true;
  return Date.now() < state.pausedUntil;
}

export function isPaused() {
  const s = _state ?? load();
  return isPauseActive(s);
}

export function getPauseReason() {
  const s = _state ?? load();
  if (!isPauseActive(s)) return null;
  return s.pauseReason;
}

// Most recent check whose timestamp is ≥24h old (= price "24h ago"). If uptime
// has been shorter than 24h, fall back to the oldest check we have, then to the
// current-day baseline. Returning null signals "no reference — skip dump check"
// so a cold-start can't spuriously trigger hedge.
function getSol24hAgoPriceFromState(state) {
  const checks = state?.checks ?? [];
  const threshold = Date.now() - 24 * 3600 * 1000;
  const older = checks.filter(c => new Date(c.timestamp).getTime() <= threshold);
  if (older.length) {
    older.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return older[0].solPrice ?? null;
  }
  if (checks.length) {
    const sorted = [...checks].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return sorted[0].solPrice ?? null;
  }
  return state?.baselineSolPrice ?? null;
}

function buildResetState({ portfolio, solPrice, baselineUsd, carryPause = false }) {
  // Reset per-day trigger flags, preserve hedgeFired (only manual /resume CONFIRM
  // clears it) and the checks history (needed for the 24h SOL lookback).
  return {
    date: getWibDate(),
    baselineSol: portfolio.totalSol,
    baselineWalletSol: portfolio.walletSol,
    baselineDeployedSol: portfolio.deployedSol,
    baselineSolPrice: solPrice,
    baselineUsdValue: baselineUsd,
    paused: carryPause ? !!_state?.paused : false,
    pauseReason: carryPause ? (_state?.pauseReason ?? null) : null,
    pauseTriggeredAt: carryPause ? (_state?.pauseTriggeredAt ?? null) : null,
    pausedUntil: carryPause ? (_state?.pausedUntil ?? null) : null,
    profitFired: false,
    lossFired: false,
    dumpWarningFired: false,
    hedgeFired: _state?.hedgeFired ?? false,
    hedgeSolPriceAtTrigger: _state?.hedgeSolPriceAtTrigger ?? null,
    lastCheckAt: new Date().toISOString(),
    lastCheckDeltaUsd: 0,
    lastSolPrice: solPrice,
    checks: _state?.checks ?? [],
  };
}

export async function resetDaily({ silent = false } = {}) {
  const portfolio = await getTotalPortfolioSol();
  const prevPrice = _state?.baselineSolPrice || _state?.lastSolPrice || 0;
  const { price: solPrice, ok: priceOk } = await safeSolPrice(prevPrice);
  const baselineUsd = portfolio.totalSol * solPrice;

  _state = buildResetState({ portfolio, solPrice, baselineUsd, carryPause: false });
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

  _state = saved;

  // Day rollover on startup: if a pause is still active (timed or indefinite),
  // keep it alive and just advance the date so the new day's reset doesn't
  // nuke the pause. Otherwise reset normally.
  if (_state.date !== today) {
    if (isPauseActive(_state)) {
      console.log(`[CircuitBreaker] stored date ${_state.date} != today ${today}, but pause active (${_state.pauseReason}) — keeping state, advancing date`);
      _state.date = today;
      save(_state);
    } else {
      console.log(`[CircuitBreaker] stored date ${_state.date} != today ${today} — reset`);
      await resetDaily();
      return _state;
    }
  }

  const status = _state.pauseReason ? `PAUSED (${_state.pauseReason}${_state.pausedUntil ? ` until ${formatWIB(new Date(_state.pausedUntil))}` : ""})` : "ACTIVE";
  console.log(`[CircuitBreaker] Initialized from file — date=${_state.date} status=${status} baseline=$${_state.baselineUsdValue.toFixed(2)}`);
  return _state;
}

// ── Auto-trigger actions ──────────────────────────────────────────────────

async function executeProfitSecure(deltaUsd, deltaSol, solPrice) {
  const solToSwap = config.profitSecureUsd / solPrice;
  const walletSol = await checkWalletBalance();
  const availableForSwap = (walletSol ?? 0) - config.walletSolReserve;
  const pauseUntilMs = Date.now() + config.profitPauseHours * 3600 * 1000;

  let swapMsg;
  if (availableForSwap < solToSwap) {
    console.log(`[CircuitBreaker] profit secure skipped — need ${solToSwap.toFixed(4)} SOL, available ${availableForSwap.toFixed(4)}`);
    swapMsg =
      `⚠️ Insufficient SOL for profit secure.\n` +
      `Need ${solToSwap.toFixed(4)} SOL, available ${availableForSwap.toFixed(4)} SOL ` +
      `(wallet ${walletSol?.toFixed(4) ?? "?"} - reserve ${config.walletSolReserve}).\n` +
      `Skipping swap.`;
  } else {
    try {
      const { swapSolToUsdc } = await import("./autoSwap.js");
      const result = await swapSolToUsdc({
        lamports: Math.floor(solToSwap * 1e9),
        slippageBps: config.slippageProfitSwap,
        usdcMint: config.usdcMint,
      });
      console.log(`[CircuitBreaker] profit secure swap OK: ${solToSwap.toFixed(4)} SOL → ${result.outAmountUsd.toFixed(2)} USDC tx=${result.signature}`);
      swapMsg =
        `Auto-swapped: ${solToSwap.toFixed(4)} SOL → $${result.outAmountUsd.toFixed(2)} USDC\n` +
        `<a href="https://solscan.io/tx/${result.signature}">TX ↗</a>`;
    } catch (err) {
      console.warn(`[CircuitBreaker] profit secure swap FAILED: ${err.message}`);
      swapMsg = `⚠️ Auto-swap FAILED: ${err.message?.slice(0, 140)}\nManual swap recommended.`;
    }
  }

  _state.paused = true;
  _state.pauseReason = "PROFIT_TARGET";
  _state.pauseTriggeredAt = new Date().toISOString();
  _state.pausedUntil = pauseUntilMs;

  await notify(
    `🎯 <b>DAILY PROFIT TARGET HIT</b> (+$${deltaUsd.toFixed(2)})\n` +
    `Delta: ${deltaSol >= 0 ? "+" : ""}${deltaSol.toFixed(4)} SOL\n\n` +
    `${swapMsg}\n\n` +
    `Hunter PAUSED ${config.profitPauseHours}h (until ${formatWIB(new Date(pauseUntilMs))})`
  );
}

async function executeLossPause(deltaUsd, deltaSol) {
  const pauseUntilMs = Date.now() + config.lossPauseHours * 3600 * 1000;
  _state.paused = true;
  _state.pauseReason = "LOSS_LIMIT";
  _state.pauseTriggeredAt = new Date().toISOString();
  _state.pausedUntil = pauseUntilMs;

  console.log(`[CircuitBreaker] loss pause armed — ${config.lossPauseHours}h until ${new Date(pauseUntilMs).toISOString()}`);

  await notify(
    `🛑 <b>DAILY LOSS LIMIT HIT</b> ($${deltaUsd.toFixed(2)})\n` +
    `Delta: ${deltaSol >= 0 ? "+" : ""}${deltaSol.toFixed(4)} SOL\n` +
    `Hunter PAUSED ${config.lossPauseHours}h (until ${formatWIB(new Date(pauseUntilMs))}).\n` +
    `Open positions tetap di-manage.`
  );
}

async function executeSOLDumpHedge(solChangePct, currentSolPrice) {
  const positions = getOpenPositions().filter(p => p && !p.mock);
  const positionIds = positions.map(p => p.id);

  console.log(`[CircuitBreaker] 🚨 SOL DUMP HEDGE TRIGGERED — ${solChangePct.toFixed(2)}% 24h, ${positionIds.length} position(s) to close`);

  await notify(
    `🚨 <b>SOL DUMP HEDGE TRIGGERED</b> 🚨\n` +
    `SOL 24h: ${solChangePct.toFixed(2)}% (below ${config.solDumpTriggerPct}% threshold)\n` +
    `Current SOL: $${currentSolPrice.toFixed(2)}\n\n` +
    `Actions:\n` +
    `1. Closing ${positionIds.length} open position(s)...\n` +
    `2. Swap remaining SOL → USDC (keep ${config.walletSolReserve} SOL reserve)\n` +
    `3. Pause INDEFINITE (manual /resume CONFIRM required)`
  );

  // Flag pause + hedge BEFORE closing so the Healer/Hunter see it mid-sequence.
  _state.paused = true;
  _state.pauseReason = "SOL_DUMP_HEDGE";
  _state.pauseTriggeredAt = new Date().toISOString();
  _state.pausedUntil = null;
  _state.hedgeFired = true;
  _state.hedgeSolPriceAtTrigger = currentSolPrice;
  save(_state);

  // Step 1: close positions sequentially, 2s between closes to pace RPC.
  let closedCount = 0;
  let closeErrors = 0;
  for (const posId of positionIds) {
    try {
      await closePosition(posId, { reason: "EMERGENCY_HEDGE" });
      closedCount++;
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      closeErrors++;
      console.error(`[CircuitBreaker] hedge close ${posId} failed: ${err.message}`);
    }
  }
  // Let close TXs settle + autoSwap (Part 13) drain dust tokens to SOL first.
  await new Promise(r => setTimeout(r, 10000));

  // Step 2: swap all freed SOL (minus reserve) to USDC.
  const walletSol = await checkWalletBalance();
  const solToSwap = (walletSol ?? 0) - config.walletSolReserve;
  let hedgeSwapResult = null;
  if (solToSwap > 0.01) {
    try {
      const { swapSolToUsdc } = await import("./autoSwap.js");
      hedgeSwapResult = await swapSolToUsdc({
        lamports: Math.floor(solToSwap * 1e9),
        slippageBps: config.slippageHedgeSwap,
        usdcMint: config.usdcMint,
      });
      console.log(`[CircuitBreaker] hedge swap OK: ${solToSwap.toFixed(4)} SOL → ${hedgeSwapResult.outAmountUsd.toFixed(2)} USDC`);
    } catch (err) {
      console.error(`[CircuitBreaker] hedge swap failed: ${err.message}`);
    }
  } else {
    console.log(`[CircuitBreaker] hedge swap skipped — only ${solToSwap.toFixed(4)} SOL available above reserve`);
  }

  save(_state);

  await notify(
    `🚨 <b>HEDGE EXECUTION COMPLETE</b> 🚨\n` +
    `Closed: ${closedCount}/${positionIds.length} positions (${closeErrors} error${closeErrors === 1 ? "" : "s"})\n` +
    `SOL→USDC: ${hedgeSwapResult
      ? `${solToSwap.toFixed(4)} SOL → $${hedgeSwapResult.outAmountUsd.toFixed(2)} USDC`
      : (solToSwap > 0.01 ? "FAILED" : `skipped (${solToSwap.toFixed(4)} SOL available)`)}\n` +
    `Wallet reserve: ~${config.walletSolReserve} SOL\n` +
    (hedgeSwapResult ? `<a href="https://solscan.io/tx/${hedgeSwapResult.signature}">TX ↗</a>\n\n` : "\n") +
    `🔒 Status: <b>PAUSED INDEFINITELY</b>\n` +
    `Use <code>/resume CONFIRM</code> when market stabilizes.`
  );
}

export async function checkCircuitBreaker({ silent = false } = {}) {
  if (!_state) _state = load();
  if (!_state) { await initDailyCircuitBreaker(); }

  // Day rollover — preserve active pauses (timed or indefinite) across midnight.
  if (_state.date !== getWibDate()) {
    if (isPauseActive(_state)) {
      console.log(`[CircuitBreaker] new day ${getWibDate()} but pause still active (${_state.pauseReason}) — skipping reset`);
      _state.date = getWibDate();
      save(_state);
    } else {
      await resetDaily();
      return _state;
    }
  }

  // Timed-pause expiry: if the pause has a deadline and it's passed, auto-resume.
  // If the pause spanned midnight, do a fresh resetDaily on the way out so
  // profitFired/lossFired and the baseline get a clean start for the new day.
  if (_state.pauseReason && _state.pausedUntil && Date.now() >= _state.pausedUntil) {
    const expiredReason = _state.pauseReason;
    const rolledOver = _state.date !== getWibDate();
    console.log(`[CircuitBreaker] timed pause expired (${expiredReason})${rolledOver ? " — rolling over to fresh day" : ""}`);
    _state.paused = false;
    _state.pauseReason = null;
    _state.pauseTriggeredAt = null;
    _state.pausedUntil = null;
    save(_state);
    if (rolledOver) await resetDaily();
    await notify(
      `▶️ <b>Circuit breaker pause expired</b>\n` +
      `Reason: ${expiredReason}\n` +
      `Hunter resumed.${rolledOver ? "\n<i>Baseline reset (new day).</i>" : ""}`
    );
  }

  const portfolio = await getTotalPortfolioSol();
  const { price: solPrice, ok: priceOk } = await safeSolPrice(_state.baselineSolPrice);
  const deltaSol = portfolio.totalSol - _state.baselineSol;
  const deltaUsd = deltaSol * solPrice;

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

  // ── 1. SOL dump guard (highest priority, runs even through pauses) ──────
  const solPrice24hAgo = getSol24hAgoPriceFromState(_state);
  if (typeof solPrice24hAgo === "number" && solPrice24hAgo > 0 && priceOk) {
    const solChangePct = ((solPrice - solPrice24hAgo) / solPrice24hAgo) * 100;

    if (solChangePct <= config.solDumpWarningPct && solChangePct > config.solDumpTriggerPct) {
      if (!_state.dumpWarningFired) {
        console.log(`[CircuitBreaker] ⚠️ SOL down ${solChangePct.toFixed(2)}% 24h — warning (approaching ${config.solDumpTriggerPct}% hedge)`);
        await notify(
          `⚠️ <b>SOL DUMP WARNING</b>\n` +
          `SOL 24h: ${solChangePct.toFixed(2)}%\n` +
          `Hedge trigger at: ${config.solDumpTriggerPct}%\n` +
          `Current SOL: $${solPrice.toFixed(2)}`
        );
        _state.dumpWarningFired = true;
        save(_state);
      }
    }

    if (solChangePct <= config.solDumpTriggerPct && !_state.hedgeFired) {
      check.triggered = true;
      await executeSOLDumpHedge(solChangePct, solPrice);
      return _state;
    }
  }

  // ── 2. Pause short-circuit for PnL triggers only ────────────────────────
  if (_state.pauseReason) {
    save(_state);
    return _state;
  }

  // ── 3. PnL triggers ─────────────────────────────────────────────────────
  if (deltaUsd >= PROFIT_TARGET_USD && !_state.profitFired) {
    check.triggered = true;
    _state.profitFired = true;
    await executeProfitSecure(deltaUsd, deltaSol, solPrice);
  } else if (deltaUsd <= LOSS_LIMIT_USD && !_state.lossFired) {
    check.triggered = true;
    _state.lossFired = true;
    await executeLossPause(deltaUsd, deltaSol);
  }

  save(_state);
  return _state;
}

export async function manualPause(reason = "MANUAL") {
  if (!_state) _state = load() ?? (await initDailyCircuitBreaker());
  _state.paused = true;
  _state.pauseReason = reason;
  _state.pauseTriggeredAt = new Date().toISOString();
  _state.pausedUntil = null; // manual pause = indefinite
  save(_state);
  console.log(`[CircuitBreaker] MANUAL PAUSE (${reason})`);
  return _state;
}

// Hedge pauses require explicit `/resume CONFIRM` (plumbed from telegramBot)
// so a mis-tapped menu button can't unwind the hedge. Other pause reasons
// accept plain resume.
export async function manualResume({ confirm = false } = {}) {
  if (!_state) _state = load() ?? (await initDailyCircuitBreaker());
  if (_state.pauseReason === "SOL_DUMP_HEDGE" && !confirm) {
    const err = new Error("HEDGE_RESUME_REQUIRES_CONFIRM");
    err.requiresConfirm = true;
    throw err;
  }
  const wasHedge = _state.pauseReason === "SOL_DUMP_HEDGE";
  _state.paused = false;
  _state.pauseReason = null;
  _state.pauseTriggeredAt = null;
  _state.pausedUntil = null;
  if (wasHedge) {
    // Allow the next hedge only after a human has acknowledged the last one.
    _state.hedgeFired = false;
    _state.dumpWarningFired = false;
  }
  save(_state);
  console.log(`[CircuitBreaker] MANUAL RESUME${wasHedge ? " (hedge cleared, hedgeFired reset)" : ""}`);
  return _state;
}

export async function getDailyStatus() {
  if (!_state) _state = load() ?? (await initDailyCircuitBreaker());
  if (_state.date !== getWibDate() && !isPauseActive(_state)) await resetDaily();

  const portfolio = await getTotalPortfolioSol();
  const { price: solPrice, ok: priceOk } = await safeSolPrice(_state.baselineSolPrice);
  const currentUsd = portfolio.totalSol * solPrice;
  const deltaSol = portfolio.totalSol - _state.baselineSol;
  const deltaUsd = deltaSol * solPrice;

  const solPrice24hAgo = getSol24hAgoPriceFromState(_state);
  const sol24hChangePct = (typeof solPrice24hAgo === "number" && solPrice24hAgo > 0 && priceOk)
    ? ((solPrice - solPrice24hAgo) / solPrice24hAgo) * 100
    : null;

  return {
    date: _state.date,
    paused: isPauseActive(_state),
    pauseReason: _state.pauseReason,
    pauseTriggeredAt: _state.pauseTriggeredAt,
    pausedUntil: _state.pausedUntil,
    pauseRemainingMs: _state.pausedUntil ? Math.max(0, _state.pausedUntil - Date.now()) : null,
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
    profitFired: !!_state.profitFired,
    lossFired: !!_state.lossFired,
    hedgeFired: !!_state.hedgeFired,
    dumpWarningFired: !!_state.dumpWarningFired,
    hedgeSolPriceAtTrigger: _state.hedgeSolPriceAtTrigger ?? null,
    sol24hChangePct,
    sol24hAgoPrice: solPrice24hAgo,
    lastCheckAt: _state.lastCheckAt,
  };
}

// Hedge-detail view for the /hedge_status command.
export async function getHedgeStatus() {
  if (!_state) _state = load() ?? (await initDailyCircuitBreaker());
  const { price: solPrice, ok: priceOk } = await safeSolPrice(_state.lastSolPrice ?? _state.baselineSolPrice);
  const trigger = _state.hedgeSolPriceAtTrigger ?? null;
  const recoveryPct = (trigger && trigger > 0 && priceOk)
    ? ((solPrice - trigger) / trigger) * 100
    : null;
  return {
    hedgeFired: !!_state.hedgeFired,
    pauseReason: _state.pauseReason,
    pauseTriggeredAt: _state.pauseTriggeredAt,
    solPriceAtTrigger: trigger,
    currentSolPrice: solPrice,
    currentSolPriceOk: priceOk,
    recoveryPct,
    dumpTriggerPct: config.solDumpTriggerPct,
    dumpWarningPct: config.solDumpWarningPct,
  };
}

// Lightweight SOL 24h change for the /sol24h command. Doesn't touch pause state.
export async function getSol24hChange() {
  if (!_state) _state = load() ?? (await initDailyCircuitBreaker());
  const { price: solPrice, ok: priceOk } = await safeSolPrice(_state.lastSolPrice ?? _state.baselineSolPrice);
  const solPrice24hAgo = getSol24hAgoPriceFromState(_state);
  const changePct = (typeof solPrice24hAgo === "number" && solPrice24hAgo > 0 && priceOk)
    ? ((solPrice - solPrice24hAgo) / solPrice24hAgo) * 100
    : null;
  return {
    currentSolPrice: solPrice,
    currentSolPriceOk: priceOk,
    solPrice24hAgo,
    changePct,
    warningPct: config.solDumpWarningPct,
    triggerPct: config.solDumpTriggerPct,
  };
}

// ── WIB-aligned 3-hour scheduler ──────────────────────────────────────────
// Fires at 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00, 21:00 WIB (8x/day).
// 00:00 performs resetDaily before the check. Per-slot dedupe so repeated 60s
// ticks within the same minute don't trigger twice.
const SCHEDULE_SLOTS = [0, 3, 6, 9, 12, 15, 18, 21]; // WIB hours
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

      // Only reset at 00:00 if no active pause is carrying over — checkCircuitBreaker
      // also handles this, so just delegate and avoid a duplicate rollover path here.
      await checkCircuitBreaker();
    } catch (e) {
      console.warn("[CircuitBreaker] scheduler tick error:", e.message);
    }
  }, 60_000);
}
