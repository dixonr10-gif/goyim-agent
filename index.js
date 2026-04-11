// index.js — Goyim Agent Orchestrator (Dual-Agent)
// Starts Hunter (30min pool scanning + entry) + Healer (10min position monitoring + exit)

import fs from "fs";
import { config } from "./config.js";
import { startDailyReviewScheduler } from "./src/reviewScheduler.js";
import { startFeeCompounder } from "./src/feeCompounder.js";
import { runHunter } from "./src/hunterAgent.js";
import { runHealer, runEmergencyPriceCheck } from "./src/healerAgent.js";
import { initTelegramBot, isAgentPaused, notifyMessage } from "./src/telegramBot.js";
import { runHealthCheck } from "./src/healthCheck.js";
import { getWIBHour } from "./src/timeHelper.js";
import { startDailyPnLReport } from "./src/dailyReport.js";

const HUNTER_INTERVAL_MS = config.loopIntervalMs;  // default 20min
const HEALER_INTERVAL_MS = 2 * 60 * 1000;           // fixed 2min

console.log("🚀 Goyim DLMM Agent (Dual-Agent) starting...");
console.log(`   Model:    ${config.openRouterModel}`);
console.log(`   Hunter:   every ${HUNTER_INTERVAL_MS / 60_000}min`);
console.log(`   Healer:   every ${HEALER_INTERVAL_MS / 60_000}min`);
console.log(`   Max SOL:  ${config.maxSolPerPosition} SOL/position`);
console.log(`   Max pos:  ${config.maxOpenPositions}`);
console.log("");

const tgBot = initTelegramBot();
startDailyReviewScheduler(tgBot, config.telegramChatId);
startDailyPnLReport(tgBot, config.telegramChatId);

// ── Healer: starts immediately, runs every 2min ───────────────────────────────
global.lastHealerRun = Date.now();
let _healerInterval = setInterval(() => {
  runHealer().then(() => { global.lastHealerRun = Date.now(); }).catch(err => console.error("[Healer interval error]", err.message));
}, HEALER_INTERVAL_MS);
runHealer().then(() => { global.lastHealerRun = Date.now(); });

// ── Watchdog: restart healer if stale > 5min ──────────────────────────────────
setInterval(async () => {
  const staleMs = Date.now() - (global.lastHealerRun || 0);
  if (staleMs > 5 * 60 * 1000) {
    console.error(`[Watchdog] Healer STALE ${Math.round(staleMs / 60000)}m → restarting`);
    try { await notifyMessage(`⚠️ Watchdog: Healer STALE ${Math.round(staleMs / 60000)}m!\n🔄 Auto-restarting...`); } catch {}
    clearInterval(_healerInterval);
    _healerInterval = setInterval(() => {
      runHealer().then(() => { global.lastHealerRun = Date.now(); }).catch(err => console.error("[Healer interval error]", err.message));
    }, HEALER_INTERVAL_MS);
    runHealer().then(() => { global.lastHealerRun = Date.now(); }).catch(() => {});
  }
}, 60 * 1000);

// ── Emergency price check: every 1min (lightweight DexScreener only) ──────────
setInterval(() => {
  runEmergencyPriceCheck().catch(err => console.error("[Emergency check error]", err.message));
}, 60 * 1000);

// ── Hunter: starts after 5s (let Healer settle first), runs every 30min ──────
setTimeout(() => {
  runHunter();
  setInterval(() => {
    runHunter().catch(err => console.error("[Hunter interval error]", err.message));
  }, HUNTER_INTERVAL_MS);
}, 5000);

// ── Health check (hourly) ─────────────────────────────────────────────────────
setInterval(() => {
  runHealthCheck(notifyMessage).catch(err => console.error("[HealthCheck error]", err.message));
}, 60 * 60 * 1000);

// ── Strict hours notification (check every 5min) ─────────────────────────────
let _lastStrictNotif = null;
setInterval(() => {
  const h = getWIBHour();
  if (h === 14 && _lastStrictNotif !== "enter") {
    _lastStrictNotif = "enter";
    notifyMessage(
      `⚠️ <b>Strict Hours Aktif</b>\n\n🕑 14:00 - 18:00 WIB\n📉 SL: -6% → <b>-4%</b>\n🎯 TP activation: +6% → <b>+4%</b>\n📊 Trail: -3% → <b>-2%</b>\n💰 Min volume: $100k → <b>$200k</b>\n⏱ Max hold: 48h → <b>2h</b>\n🔄 OOR kanan: 35m → <b>20m</b>\n🔄 OOR kiri: 15m → <b>10m</b>\n\nBot tetap jalan tapi lebih selektif!`
    ).catch(() => {});
  } else if (h === 18 && _lastStrictNotif !== "exit") {
    _lastStrictNotif = "exit";
    notifyMessage(
      `✅ <b>Normal Hours</b>\n\n🕕 18:00 WIB - parameter kembali normal\n📉 SL: -6% | 🎯 TP: +6% | 📊 Trail: -3%\n💰 Min volume: $100k\n⏱ Max hold: 48h | 🔄 OOR: 35m/15m`
    ).catch(() => {});
  } else if (h !== 14 && h !== 18) {
    _lastStrictNotif = null;
  }
}, 5 * 60 * 1000);

// ── Fee compounder (background) ───────────────────────────────────────────────
startFeeCompounder(() => {
  try { return JSON.parse(fs.readFileSync("./data/open_positions.json", "utf-8")); }
  catch { return {}; }
}, 30);
