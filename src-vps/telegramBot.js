import { Telegraf, Markup } from "telegraf";
import { config } from "../config.js";
import { getOpenPositions, closePosition } from "./positionManager.js";
import { getFullStats } from "./tradeMemory.js";
import { getSOLBalance, getTokenBalances, getWalletAddress, formatWalletMessage, getSolPriceUSD, getUsdToIdrRate } from "./walletInfo.js";

export function esc(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

let bot;
let agentPaused = false;
let sessionStats = {
  totalOpened: 0,
  totalClosed: 0,
  startedAt: new Date().toISOString(),
  lastDecision: null,
  lastError: null,
};

function isAuthorizedChat(ctx) {
  const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? "");
  const allowed = String(config.telegramChatId ?? "");
  if (!allowed) return true; // no restriction if not configured
  if (chatId === allowed) return true;
  console.log(`[Security] message from unauthorized chat ${chatId} ignored`);
  return false;
}

export function initTelegramBot() {
  if (!config.telegramBotToken) return null;
  bot = new Telegraf(config.telegramBotToken);

  // Global security middleware — silently ignore unauthorized chats
  bot.use((ctx, next) => {
    if (!isAuthorizedChat(ctx)) return; // drop silently
    return next();
  });

  registerCommands();
  registerCallbacks();
  bot.catch((err) => {
    if (err.message?.includes("not modified")) return; // ignore "message is not modified"
    console.error("Telegraf error:", err.message);
  });
  bot.launch();
  console.log("🤖 Telegram bot started");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
  return bot;
}

export const isAgentPaused = () => agentPaused;
export const updateLastDecision = (d) => { sessionStats.lastDecision = d; };
export const recordPositionOpened = () => sessionStats.totalOpened++;
export const recordPositionClosed = () => sessionStats.totalClosed++;
export const recordError = (msg) => { sessionStats.lastError = { msg, at: new Date().toISOString() }; };

function registerCommands() {
  bot.start(async (ctx) => {
    await ctx.replyWithHTML(
      `<b>🤖 Goyim DLMM Agent</b>\n\nYo! Gue Goyim — AI trading agent lo di Solana.\nLagi hunting alpha di Meteora DLMM.\n\nGunakan tombol di bawah atau ajak gue ngobrol langsung!`,
      mainMenu()
    );
  });

  bot.command("status", async (ctx) => { await ctx.replyWithHTML(buildStatusMessage(), mainMenu()); });
  bot.command("pause", async (ctx) => { agentPaused = true; await ctx.replyWithHTML(`⏸️ <b>Oke, gue istirahat dulu.</b>`, resumeMenu()); });
  bot.command("resume", async (ctx) => { agentPaused = false; await ctx.replyWithHTML(`▶️ <b>Siap, balik hunting alpha!</b>`, mainMenu()); });
  bot.command("closeall", async (ctx) => { await ctx.replyWithHTML(`⚠️ <b>Yakin mau close semua posisi?</b>`, confirmCloseAllMenu()); });

  bot.command("wallet", async (ctx) => {
    await ctx.reply("⏳ Ngecek wallet...");
    try {
      const address = await getWalletAddress();
      const [sol, tokens, solPrice, idrRate] = await Promise.all([getSOLBalance(address), getTokenBalances(address), getSolPriceUSD(), getUsdToIdrRate()]);
      await ctx.replyWithHTML(formatWalletMessage(address, sol, tokens, solPrice, idrRate), mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("pnl", async (ctx) => {
    try {
      const period = ctx.message.text.split(/\s+/)[1]?.toLowerCase() ?? "weekly";
      const valid = ["daily", "weekly", "monthly"];
      const p = valid.includes(period) ? period : "weekly";
      await ctx.reply(`📊 Generating ${p} PnL card...`);
      const { sendPnlCard } = await import("./pnlCard.js");
      await sendPnlCard(bot, ctx.chat.id, p);
    } catch (err) {
      await ctx.replyWithHTML(buildPnLMessage(), mainMenu());
    }
  });
  bot.command("winrate", async (ctx) => { await ctx.replyWithHTML(buildWinRateMessage(), mainMenu()); });
  bot.command("history", async (ctx) => { await ctx.replyWithHTML(buildHistoryMessage(), mainMenu()); });
  bot.command("lessons", async (ctx) => { await ctx.replyWithHTML(await buildLessonsMessage(), mainMenu()); });

  bot.command("positions", async (ctx) => {
    const positions = getOpenPositions();
    if (positions.length === 0) { await ctx.reply("📭 Gak ada posisi aktif nih.", mainMenu()); return; }
    await ctx.replyWithHTML(await buildPositionsMessage(positions), positionsMenu(positions));
  });

  bot.command("review", async (ctx) => {
    await ctx.reply("📊 Lagi nulis daily review, bentar...");
    try {
      const { generateDailyReview } = await import("./goyimChat.js");
      const review = await generateDailyReview();
      await ctx.replyWithHTML(`<b>📋 Daily Review</b>\n\n${esc(review)}`, mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("evolve", async (ctx) => {
    await ctx.reply("🧬 Running threshold evolution...");
    try {
      const { getFullStats } = await import("./tradeMemory.js");
      const { maybeEvolveThresholds } = await import("./thresholdEvolver.js");
      const { stats } = getFullStats();
      maybeEvolveThresholds(stats);
      const msg = `🧬 <b>Threshold Evolution</b>\n\nTrades: ${stats.totalTrades ?? 0} | WR: ${stats.hitRate ?? 0}% | avgPnL: ${stats.avgPnlPercent ?? 0}%\n\n<i>Check logs for changes. Agent will use new thresholds next loop.</i>`;
      await ctx.replyWithHTML(msg, mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("candidates", async (ctx) => {
    try {
      const { getLastCandidates } = await import("./poolScanner.js");
      const pools = getLastCandidates();
      if (!pools.length) { await ctx.reply("📭 No candidates yet. Wait for next Hunter scan.", mainMenu()); return; }
      const fmtMcap = (n) => {
        if (!n || n <= 0) return "?";
        if (n >= 1e9) return `$${(n/1e9).toFixed(1)}B`;
        if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
        return `$${(n/1000).toFixed(0)}k`;
      };
      let msg = `<b>🎯 Pool Candidates (${pools.length})</b>\n${"─".repeat(25)}\n\n`;
      pools.slice(0, 8).forEach((p, i) => {
        const vol = p.volume?.["24h"] ?? 0;
        const tvl = p.tvl ?? 0;
        const apr = ((p.apr ?? 0) * 100).toFixed(1);
        const mcap = p.dexPair?.marketCap ?? p.dexPair?.fdv ?? 0;
        msg += `${i + 1}. <b>${esc(p.name)}</b>${p.uptrend ? " 🚀" : ""}\n`;
        msg += `   Vol: $${(vol / 1000).toFixed(0)}k | TVL: $${(tvl / 1000).toFixed(0)}k | APR: ${apr}% | Organic: ${p.organicScore ?? "?"}/100 | MCap: ${fmtMcap(mcap)}\n`;
        msg += `   📊 https://dexscreener.com/solana/${p.address}\n\n`;
      });
      await ctx.replyWithHTML(msg, mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("thresholds", async (ctx) => {
    const c = config;
    const tp = process.env.TAKE_PROFIT_PERCENT ?? "5";
    const sl = process.env.STOP_LOSS_PERCENT ?? "-3";
    const mh = process.env.MAX_HOLD_HOURS ?? "3";
    const minFeeApr = c.minFeeAprFilter ?? (Number(process.env.MIN_FEE_APR_FILTER) || 10);
    const minFeeAprHold = parseFloat(process.env.MIN_FEE_APR_TO_HOLD) || 10;
    const msg =
      `<b>⚙️ Current Thresholds</b>\n${"─".repeat(25)}\n\n` +
      `Min Volume 24h: <b>$${(c.minPoolVolumeUsd / 1000).toFixed(0)}k</b>\n` +
      `Min Fee APR: <b>${minFeeApr}%</b>\n` +
      `Max TVL: <b>$${(c.maxTvlUsd / 1000).toFixed(0)}k</b>\n` +
      `Min Organic Score: <b>${c.minOrganicScore}/100</b>\n\n` +
      `Max SOL/position: <b>${c.maxSolPerPosition} SOL</b>\n` +
      `Max open positions: <b>${c.maxOpenPositions}</b>\n` +
      `Min SOL to open: <b>${c.minSolToOpen} SOL</b>\n\n` +
      `Take Profit: <b>+${tp}%</b>\n` +
      `Stop Loss: <b>${sl}%</b>\n` +
      `Max Hold Time: <b>${mh}h</b>\n` +
      `Min Fee APR to Hold: <b>${minFeeAprHold}%</b>\n` +
      `OOR Wait: <b>${c.outOfRangeWaitMinutes} min</b>\n` +
      `Fee TP: <b>${(c.takeProfitFeePct * 100).toFixed(0)}% of deployed</b>`;
    await ctx.replyWithHTML(msg, mainMenu());
  });

  bot.command("cooldowns", async (ctx) => {
    try {
      const { getActiveCooldowns } = await import("./cooldownManager.js");
      const active = getActiveCooldowns();
      if (active.length === 0) {
        await ctx.replyWithHTML("✅ <b>No active cooldowns</b>\nAll tokens available for entry.", mainMenu());
        return;
      }
      let msg = `<b>⏳ Active Cooldowns (${active.length})</b>\n\n`;
      active.forEach(({ symbol, remaining }) => {
        msg += `• <b>${symbol}</b>: ${remaining} remaining\n`;
      });
      await ctx.replyWithHTML(msg, mainMenu());
    } catch (err) {
      console.error("[TG] /cooldowns error:", err.message);
      await ctx.reply(`❌ ${err.message}`);
    }
  });

  // Aliases for common typos
  bot.command("cooldown", async (ctx) => {
    try {
      const { getActiveCooldowns } = await import("./cooldownManager.js");
      const { getOORCooldowns } = await import("./blacklistManager.js");
      const active = getActiveCooldowns();
      const oorCd = getOORCooldowns();
      const oorActive = Object.entries(oorCd).filter(([, v]) => new Date(v.until) > new Date());

      if (active.length === 0 && oorActive.length === 0) {
        await ctx.replyWithHTML("✅ <b>No tokens on cooldown</b>", mainMenu());
        return;
      }
      let msg = `<b>⏳ Cooldowns (${active.length + oorActive.length} tokens)</b>\n\n`;
      if (active.length > 0) {
        msg += `<b>Trade cooldowns:</b>\n`;
        active.forEach(({ symbol, remaining }) => { msg += `  ${symbol} — ${remaining} remaining\n`; });
      }
      if (oorActive.length > 0) {
        msg += `\n<b>OOR cooldowns:</b>\n`;
        for (const [sym, v] of oorActive) {
          const rem = Math.max(0, new Date(v.until) - Date.now());
          const h = Math.floor(rem / 3_600_000);
          const m = Math.floor((rem % 3_600_000) / 60_000);
          const untilWIB = new Date(v.until).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" });
          msg += `  ${sym} — until ${untilWIB} WIB (${h}h ${m}m remaining)\n`;
        }
      }
      await ctx.replyWithHTML(msg, mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  // ── PM2 Control Commands ─────────────────────────────────────────
  bot.command("restart", async (ctx) => {
    try {
      const { execSync } = await import("child_process");
      await ctx.reply("🔄 Restarting goyim-agent...");
      execSync("pm2 restart goyim-agent", { timeout: 10000 });
    } catch {}
    // Note: process will restart, so this reply may not arrive
  });

  bot.command("pm2status", async (ctx) => {
    try {
      const { execSync } = await import("child_process");
      const raw = execSync("pm2 jlist 2>/dev/null", { timeout: 10000 }).toString();
      const procs = JSON.parse(raw);
      const p = procs.find(x => x.name === "goyim-agent");
      if (!p) { await ctx.reply("❌ Process goyim-agent not found in PM2"); return; }
      const env = p.pm2_env || {};
      const uptime = env.pm_uptime ? Math.floor((Date.now() - env.pm_uptime) / 60000) : 0;
      const uptimeH = Math.floor(uptime / 60);
      const uptimeM = uptime % 60;
      const mem = ((p.monit?.memory || 0) / 1048576).toFixed(1);
      const cpu = p.monit?.cpu ?? 0;
      const restarts = env.restart_time ?? 0;
      const status = env.status ?? "unknown";
      const statusIcon = status === "online" ? "🟢" : status === "stopped" ? "🔴" : "🟡";
      const pid = p.pid ?? "?";
      const msg =
        `<b>⚙️ PM2 Status — goyim-agent</b>\n${"─".repeat(25)}\n\n` +
        `Status: ${statusIcon} <b>${status.toUpperCase()}</b>\n` +
        `PID: <code>${pid}</code>\n` +
        `Uptime: <b>${uptimeH}h ${uptimeM}m</b>\n` +
        `Memory: <b>${mem} MB</b>\n` +
        `CPU: <b>${cpu}%</b>\n` +
        `Restarts: <b>${restarts}</b>\n` +
        `Node: <b>${env.node_version ?? "?"}</b>`;
      await ctx.replyWithHTML(msg, mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("logs", async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1]?.toLowerCase();
    if (arg === "live") {
      try {
        const { execSync } = await import("child_process");
        let raw = execSync("pm2 logs goyim-agent --lines 30 --nostream 2>&1", { timeout: 10000 }).toString();
        raw = raw.replace(/\x1B\[[0-9;]*[mGKH]/g, "");
        const lines = raw.split("\n")
          .map(l => l.replace(/^.*?goyim-ag\s*\|\s*/, "").trim())
          .filter(l => l.length > 0 && !l.startsWith("[TAILING]") && !l.includes("last ") && !l.includes(".pm2/logs"))
          .slice(-30);
        const timeStr = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" });
        let text = `📋 Live Logs — 30 lines\n⏰ ${timeStr} WIB\n━━━━━━━━━━━━━━━\n`;
        text += lines.join("\n");
        if (text.length > 4000) text = text.slice(-4000);
        await ctx.reply(text);
      } catch (err) { await ctx.reply(`❌ ${err.message}`); }
      return;
    }
    // Default: show log category menu
    await ctx.reply("📋 Pilih kategori log:", {
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📈 PnL", "logs_pnl"), Markup.button.callback("🎯 Hunter", "logs_hunter")],
        [Markup.button.callback("💊 Healer", "logs_healer"), Markup.button.callback("🚨 Error", "logs_error")],
        [Markup.button.callback("📋 Live 30", "logs_live"), Markup.button.callback("📊 All", "logs_all")],
        [Markup.button.callback("❌ Cancel", "logs_cancel")],
      ]),
    });
  });

  bot.command("stop", async (ctx) => {
    await ctx.replyWithHTML(
      `⚠️ <b>Yakin mau stop bot?</b>\n\nBot akan berhenti total sampai di-start manual.\nKetik /confirmstop untuk konfirmasi.`,
      mainMenu()
    );
  });

  bot.command("confirmstop", async (ctx) => {
    try {
      const { execSync } = await import("child_process");
      await ctx.reply("🔴 Stopping goyim-agent...");
      execSync("pm2 stop goyim-agent", { timeout: 10000 });
      await ctx.reply("✅ Bot stopped. Use `pm2 start goyim-agent` on VPS to restart.");
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("learn", async (ctx) => {
    const parts = ctx.message.text.split(" ");
    const poolAddress = parts[1]?.trim() ?? null;
    await ctx.reply(`📚 Studying ${poolAddress ? `pool ${poolAddress.slice(0, 8)}...` : "top LPs"}...`);
    try {
      const { studyTopLPs } = await import("./lpStudy.js");
      const result = await studyTopLPs(poolAddress);
      if (!result.lessons.length) { await ctx.reply("📭 No lessons extracted.", mainMenu()); return; }
      const lessonsText = result.lessons.slice(0, 6).map((l, i) => `${i + 1}. [${l.confidence}%] ${esc(l.lesson)}`).join("\n\n");
      await ctx.replyWithHTML(`<b>📚 LP Lessons (${result.lessons.length} saved)</b>\n\n${lessonsText}`, mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("blacklist", async (ctx) => {
    try {
      const args = ctx.message.text.split(/\s+/).slice(1);
      const { getBlacklist, getTokenLosses, manualBlacklist, unblacklistToken } = await import("./blacklistManager.js");

      // /blacklist remove SYMBOL → unblacklist
      const subcmd = args[0]?.toLowerCase();
      if (subcmd === "remove" || subcmd === "delete" || subcmd === "rm") {
        const sym = args[1]?.toUpperCase();
        if (!sym) { await ctx.reply("Usage: /blacklist remove SYMBOL"); return; }
        const ok = unblacklistToken(sym);
        await ctx.reply(ok ? `✅ ${sym} dihapus dari blacklist` : `⚠️ ${sym} tidak ditemukan di blacklist`);
        return;
      }

      // /blacklist add SYMBOL, /blacklist SYMBOL, or /blacklist CA
      const addArg = subcmd === "add" ? args[1] : args[0];
      if (addArg && !/^(show|list)$/i.test(addArg)) {
        let symbol = addArg.toUpperCase();
        const CA_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
        if (CA_REGEX.test(addArg)) {
          // Resolve CA to symbol via DexScreener
          try {
            const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addArg}`, { signal: AbortSignal.timeout(8000) });
            const data = await res.json();
            const pair = data?.pairs?.[0];
            symbol = (pair?.baseToken?.symbol ?? addArg.slice(0, 8)).toUpperCase();
            await ctx.reply(`🔍 CA resolved: ${symbol}`);
          } catch { await ctx.reply(`⚠️ Cannot resolve CA, using ${symbol}`); }
        }
        const result = await manualBlacklist(symbol);
        await ctx.reply(`✅ ${result} ditambahkan ke blacklist`);
        return;
      }

      // /blacklist → show list
      const list = getBlacklist();
      const losses = getTokenLosses();
      const { getTokenLossesWithDates } = await import("./blacklistManager.js");
      const lossData = getTokenLossesWithDates();
      const now = Date.now();
      const WEEK = 7 * 86400000;

      let msg = `<b>🚫 Blacklisted: ${list.length} total</b>\n\n`;

      // Recent (7 days)
      const recent = Object.entries(lossData)
        .filter(([, v]) => (v?.count ?? 0) >= 3 && v?.blacklistedAt && (now - new Date(v.blacklistedAt).getTime()) < WEEK)
        .map(([s]) => s);
      if (recent.length > 0) {
        msg += `<b>🆕 Recent (7d):</b> ${recent.join(", ")}\n`;
      }

      // Auto-blacklisted with loss count
      const autoEntries = Object.entries(losses).filter(([, c]) => c >= 3);
      if (autoEntries.length > 0) {
        msg += `<b>🤖 Auto (3L+):</b> ${autoEntries.sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}: ${c}L`).join(", ")}\n`;
      }

      // Static count (don't list all JUP, WBTC etc)
      const staticCount = list.length - autoEntries.length;
      if (staticCount > 0) msg += `<b>🔒 Static:</b> ${staticCount} tokens (large-cap/env)\n`;

      // Watch list
      const watchEntries = Object.entries(losses).filter(([, c]) => c > 0 && c < 3);
      if (watchEntries.length > 0) {
        msg += `\n<b>👀 Watch:</b> ${watchEntries.sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}: ${c}L`).join(", ")}\n`;
      }
      msg += `\n<i>Tambah: /blacklist add SYMBOL\nHapus: /blacklist remove SYMBOL</i>`;
      await ctx.replyWithHTML(msg, mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("watchlist", async (ctx) => {
    try {
      const { getTokenLosses, getOORStrikes } = await import("./blacklistManager.js");
      const losses = getTokenLosses();
      const oor = getOORStrikes();
      const allSyms = new Set([...Object.keys(losses), ...Object.keys(oor)]);

      const watchLoss = Object.entries(losses).filter(([, c]) => c > 0 && c < 3).sort((a, b) => b[1] - a[1]);
      const watchOOR = Object.entries(oor).filter(([, c]) => c > 0 && c < 4).sort((a, b) => b[1] - a[1]);
      const combo = [...allSyms].filter(s => (losses[s] ?? 0) >= 1 && (oor[s] ?? 0) >= 1).sort();

      if (watchLoss.length === 0 && watchOOR.length === 0) {
        await ctx.replyWithHTML("✅ <b>No tokens on watch list</b>", mainMenu());
        return;
      }

      let msg = `<b>👀 Watch List</b>\n\n`;
      if (watchLoss.length > 0) {
        msg += `<b>Loss strikes:</b>\n`;
        for (const [sym, c] of watchLoss) msg += `  ${sym} — ${c} loss${c > 1 ? "es ⚠️" : ""}\n`;
        msg += `\n`;
      }
      if (watchOOR.length > 0) {
        msg += `<b>OOR strikes:</b>\n`;
        for (const [sym, c] of watchOOR) msg += `  ${sym} — ${c} OOR strike${c > 1 ? "s" : ""}\n`;
        msg += `\n`;
      }
      if (combo.length > 0) {
        msg += `<b>Combo watch (loss + OOR):</b>\n`;
        for (const sym of combo) msg += `  ${sym} — ${losses[sym] ?? 0} loss + ${oor[sym] ?? 0} OOR\n`;
      }
      await ctx.replyWithHTML(msg, mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("logs", async (ctx) => {
    const keyword = ctx.message.text.split(/\s+/).slice(1).join(" ").trim() || null;
    await sendLogs(ctx, keyword);
  });

  bot.command("unblacklist", async (ctx) => {
    try {
      const symbol = ctx.message.text.split(/\s+/)[1]?.toUpperCase();
      if (!symbol) { await ctx.reply("Usage: /unblacklist SYMBOL"); return; }
      const { unblacklistToken } = await import("./blacklistManager.js");
      const ok = unblacklistToken(symbol);
      await ctx.reply(ok ? `✅ ${symbol} removed from auto-blacklist` : `⚠️ ${symbol} not found in auto-blacklist`);
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("recordclose", async (ctx) => {
    try {
      const args = ctx.message.text.split(/\s+/).slice(1);
      if (args.length < 3) {
        await ctx.reply("Format: /recordclose SYMBOL PNL% SOL\nContoh: /recordclose 49-SOL +9.64 3");
        return;
      }
      const symbol = args[0];
      const pnlPercent = parseFloat(args[1]);
      const solDeployed = parseFloat(args[2]);
      if (isNaN(pnlPercent) || isNaN(solDeployed)) { await ctx.reply("PnL% dan SOL harus angka!"); return; }

      const { recordTradeClose } = await import("./tradeMemory.js");
      recordTradeClose({
        positionId: "manual_" + Date.now(),
        solReturned: solDeployed * (1 + pnlPercent / 100),
        preClosePnlPct: pnlPercent,
        poolName: symbol,
        solDeployed,
      });

      const emoji = pnlPercent > 0.5 ? "✅" : pnlPercent < -0.5 ? "❌" : "➡️";
      const outcome = pnlPercent > 0.5 ? "WIN" : pnlPercent < -0.5 ? "LOSS" : "BREAKEVEN";
      await ctx.reply(`${emoji} Trade recorded!\nPool: ${symbol}\nPnL: ${pnlPercent > 0 ? "+" : ""}${pnlPercent}%\nSOL: ${solDeployed}\nOutcome: ${outcome}`);
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("ghosts", async (ctx) => {
    try {
      const { getGhostBlacklist, clearGhostBlacklist } = await import("./positionManager.js");
      const bl = getGhostBlacklist();
      const entries = Object.entries(bl);
      if (entries.length === 0) { await ctx.reply("✅ No ghost positions blacklisted"); return; }
      let msg = `👻 Ghost Blacklist (${entries.length})\n\n`;
      for (const [id, v] of entries) msg += `${id.slice(0, 16)}...\n  ${v.reason}\n  ${v.addedAt?.slice(0, 16)}\n\n`;
      const args = ctx.message.text.split(/\s+/);
      if (args[1] === "clear") { clearGhostBlacklist(); await ctx.reply("✅ Ghost blacklist cleared"); return; }
      await ctx.reply(msg + "Tip: /ghosts clear to reset");
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("help", async (ctx) => {
    await ctx.replyWithHTML(
      `<b>📖 Commands:</b>\n\n` +
      `/status — Status agent\n/wallet — Saldo wallet\n/pnl — P&L summary\n` +
      `/winrate — Win rate\n/history — Riwayat trade\n/positions — Posisi aktif\n` +
      `/review — Daily review\n/evolve — Evolve thresholds\n` +
      `/candidates — Pool scan results\n/thresholds — Config thresholds\n` +
      `/cooldowns — Active token cooldowns\n/blacklist — Blacklisted tokens\n` +
      `/watchlist — Token watch list\n/unblacklist [sym] — Remove from blacklist\n` +
      `/logs [keyword] — PM2 logs (filter optional)\n` +
      `/learn [pool] — Study LP patterns\n` +
      `/recordclose SYM PNL SOL — Catat close manual\n` +
      `/pause & /resume — Jeda/lanjut\n/closeall — Tutup semua\n\n` +
      `<b>CA Scanner:</b> Kirim contract address langsung ke chat!\n\n` +
      `<i>Atau langsung chat aja!</i>`
    );
  });

  
// Handle foto dari user
bot.on("photo", async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    await ctx.sendChatAction("typing");
    
    // Ambil foto terbesar
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const fileLink = await ctx.telegram.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${fileLink.file_path}`;
    
    // Download foto sebagai base64
    const res = await fetch(fileUrl);
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    
    const caption = ctx.message.caption ?? "Goyim, analisa gambar ini dong.";
    
    // Kirim ke Claude vision
    const { chatWithGoyimVision } = await import("./goyimChat.js");
    let reply = await chatWithGoyimVision(userId, caption, base64);
    const vWords = (reply ?? "").split(/\s+/);
    const vUnique = new Set(vWords);
    if (vWords.length > 20 && vUnique.size < vWords.length * 0.3) {
      console.error(`[VISION] Loop guard triggered`);
      reply = "⚠️ Response error. Coba lagi.";
    }
    if (reply && reply.length > 4000) reply = reply.slice(0, 4000) + "...";
    await ctx.reply(reply);
  } catch (err) {
    console.error("[PHOTO] Error:", err.message);
    await ctx.reply("Gagal proses foto bro: " + err.message.slice(0, 100));
  }
});
// CHAT HANDLER - detect CA (Solana address) or forward to chat
  const CA_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  bot.on("text", async (ctx) => {
    const text = ctx.message?.text?.trim();
    console.log("[CHAT] Incoming:", text);
    if (!text || text.startsWith("/")) return;

    // Detect Solana contract address
    if (CA_REGEX.test(text)) {
      console.log("[CA] Detected Solana address:", text.slice(0, 8));
      await ctx.sendChatAction("typing");
      try {
        const { scanCA, formatCAScanMessage } = await import("./caScanner.js");
        const scan = await scanCA(text);
        const msg = formatCAScanMessage(scan);
        const bestPool = scan.pools[0];
        const buttons = [];
        if (bestPool && scan.score >= 20) {
          buttons.push([
            Markup.button.callback("✅ Open Position", `ca_open_${bestPool.address}`),
            Markup.button.callback("❌ Skip", "ca_cancel"),
            Markup.button.callback("🔄 Refresh", `ca_refresh_${text}`),
          ]);
        } else {
          buttons.push([
            Markup.button.callback("🔄 Refresh", `ca_refresh_${text}`),
            Markup.button.callback("❌ Close", "ca_cancel"),
          ]);
        }
        await ctx.replyWithHTML(msg, { disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) });
      } catch (err) {
        console.error("[CA] Scan error:", err.message);
        await ctx.reply(`❌ Scan failed: ${err.message.slice(0, 100)}`);
      }
      return;
    }

    // Regular chat
    const userId = String(ctx.from.id);
    try {
      await ctx.sendChatAction("typing");
      const { chatWithGoyim } = await import("./goyimChat.js");
      console.log("[CHAT] Calling chatWithGoyim...");
      let reply = await chatWithGoyim(userId, ctx.message.text);
      // Guard: detect loop/spam before sending
      const words = (reply ?? "").split(/\s+/);
      const unique = new Set(words);
      if (words.length > 20 && unique.size < words.length * 0.3) {
        console.error(`[CHAT] Loop guard triggered: ${unique.size}/${words.length} unique words`);
        reply = "⚠️ Response error. Coba lagi.";
      }
      if (reply && reply.length > 4000) reply = reply.slice(0, 4000) + "...";
      console.log("[CHAT] Reply:", reply?.slice(0, 80));
      await ctx.reply(reply);
    } catch (err) {
      console.error("[CHAT] Error:", err.message);
      await ctx.reply("Error bro: " + err.message.slice(0, 100));
    }
  });
}

// ── Shared log fetcher ──────────────────────────────────────────────
const LOG_NOISE = /bins:|dec=\d|tokenPrice: pool=|X=.*Y=So|unclaimedFees|claimedFees|positionFeeX|mint decimals/i;
const LOG_SHOW = /PnL=|OPEN|CLOSE|ERROR|BLACKLIST|Hunter Agent|Healer Agent|TrailingTP|Rebalance|PositionSize|Strategy|qualifying pools|candidates:/i;

async function sendLogs(ctx, keyword) {
  try {
    const { execSync } = await import("child_process");
    let raw = execSync("pm2 logs goyim-agent --lines 200 --nostream 2>&1", { timeout: 10000 }).toString();
    raw = raw.replace(/\x1B\[[0-9;]*[mGKH]/g, "");
    let lines = raw.split("\n")
      .map(l => l.replace(/^.*?goyim-ag\s*\|\s*/, "").trim())
      .filter(l => l.length > 0 && !LOG_NOISE.test(l));
    if (keyword) {
      lines = lines.filter(l => l.toLowerCase().includes(keyword.toLowerCase()));
    } else {
      lines = lines.filter(l => LOG_SHOW.test(l));
    }
    lines = lines.slice(-25);
    if (lines.length === 0) { await ctx.reply(`📋 No logs found${keyword ? " for: " + keyword : ""}`); return; }
    const timeStr = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" });
    let text = `📋 Logs${keyword ? " [" + keyword + "]" : ""} — ${lines.length} lines\n⏰ ${timeStr} WIB\n━━━━━━━━━━━━━━━\n`;
    text += lines.join("\n");
    text += "\n━━━━━━━━━━━━━━━";
    if (text.length > 4000) text = text.slice(-4000);
    await ctx.reply(text);
  } catch (err) { await ctx.reply("❌ Error: " + err.message.slice(0, 100)); }
}

function registerCallbacks() {
  bot.action("status", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(buildStatusMessage(), { parse_mode: "HTML", ...mainMenu() });
  });
  bot.action("wallet", async (ctx) => {
    await ctx.answerCbQuery("⏳ Loading...");
    try {
      const address = await getWalletAddress();
      const [sol, tokens, solPrice, idrRate] = await Promise.all([getSOLBalance(address), getTokenBalances(address), getSolPriceUSD(), getUsdToIdrRate()]);
      await ctx.editMessageText(formatWalletMessage(address, sol, tokens, solPrice, idrRate), { parse_mode: "HTML", ...mainMenu() });
    } catch (err) { await ctx.editMessageText(`❌ ${err.message}`, { ...mainMenu() }); }
  });
  bot.action("pnl", async (ctx) => {
    await ctx.answerCbQuery("📊 Generating...");
    try {
      const { sendPnlCard } = await import("./pnlCard.js");
      await sendPnlCard(bot, ctx.chat.id, "weekly");
    } catch {
      await ctx.editMessageText(buildPnLMessage(), { parse_mode: "HTML", ...mainMenu() });
    }
  });
  bot.action("winrate", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(buildWinRateMessage(), { parse_mode: "HTML", ...mainMenu() });
  });
  bot.action("history", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(buildHistoryMessage(), { parse_mode: "HTML", ...mainMenu() });
  });
  bot.action("lessons", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(await buildLessonsMessage(), { parse_mode: "HTML", ...mainMenu() });
  });
  bot.action("positions", async (ctx) => {
    await ctx.answerCbQuery();
    const positions = getOpenPositions();
    if (positions.length === 0) { await ctx.editMessageText("📭 Gak ada posisi aktif.", { ...mainMenu() }); return; }
    await ctx.editMessageText(await buildPositionsMessage(positions), { parse_mode: "HTML", ...positionsMenu(positions) });
  });
  bot.action("review", async (ctx) => {
    await ctx.answerCbQuery("📊 Generating...");
    try {
      await ctx.editMessageText("📊 Lagi nulis daily review...");
      const { generateDailyReview } = await import("./goyimChat.js");
      const review = await generateDailyReview();
      await ctx.editMessageText(`<b>📋 Daily Review</b>\n\n${esc(review)}`, { parse_mode: "HTML", ...mainMenu() });
    } catch (err) { await ctx.editMessageText(`❌ ${err.message}`, { ...mainMenu() }); }
  });
  bot.action("pause", async (ctx) => {
    agentPaused = true;
    await ctx.answerCbQuery("⏸️");
    await ctx.editMessageText(`⏸️ <b>Oke, gue istirahat dulu.</b>`, { parse_mode: "HTML", ...resumeMenu() });
  });
  bot.action("resume", async (ctx) => {
    agentPaused = false;
    await ctx.answerCbQuery("▶️");
    await ctx.editMessageText(`▶️ <b>Siap, balik hunting alpha!</b>`, { parse_mode: "HTML", ...mainMenu() });
  });
  bot.action("closeall_confirm_prompt", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`⚠️ <b>Yakin close semua?</b>`, { parse_mode: "HTML", ...confirmCloseAllMenu() });
  });
  bot.action("closeall_yes", async (ctx) => {
    await ctx.answerCbQuery("⏳");
    const positions = getOpenPositions();
    const { recordTradeClose } = await import("./tradeMemory.js");
    let closed = 0;
    for (const pos of positions) {
      try {
        const result = await closePosition(pos.id, { reason: "MANUAL_CLOSEALL" });
        const solReturned = result?.solReceived ?? pos.solDeployed;
        recordTradeClose({ positionId: pos.id, solReturned, poolName: pos.poolName, solDeployed: pos.solDeployed, closeReason: "MANUAL_CLOSEALL" });
        closed++;
      } catch {}
    }
    await ctx.editMessageText(`✅ <b>${closed} posisi ditutup.</b>`, { parse_mode: "HTML", ...mainMenu() });
  });
  bot.action("closeall_no", async (ctx) => {
    await ctx.answerCbQuery("Dibatalkan");
    await ctx.editMessageText("↩️ Oke, posisi tetap.", { ...mainMenu() });
  });
  bot.action(/^close_(.+)$/, async (ctx) => {
    const posId = ctx.match[1];
    await ctx.answerCbQuery("Closing...");
    try {
      const pos = getOpenPositions().find(p => p.id === posId);
      const result = await closePosition(posId, { reason: "MANUAL" });
      const solReturned = result?.solReceived ?? pos?.solDeployed;
      const { recordTradeClose } = await import("./tradeMemory.js");
      recordTradeClose({ positionId: posId, solReturned, poolName: pos?.poolName, solDeployed: pos?.solDeployed, closeReason: "MANUAL" });
      const txSigs = result?.txSignatures ?? [];
      let msg = `✅ Posisi closed!`;
      if (txSigs.length > 0) msg += `\n\n🔍 <a href="https://solscan.io/tx/${txSigs[0]}">View TX ↗</a>`;
      await ctx.editMessageText(msg, { parse_mode: "HTML", disable_web_page_preview: true, ...mainMenu() });
    } catch (err) { await ctx.editMessageText(`❌ ${err.message}`, { ...mainMenu() }); }
  });
  bot.action("refresh", async (ctx) => {
    await ctx.answerCbQuery("🔄");
    await ctx.editMessageText(buildStatusMessage(), { parse_mode: "HTML", ...mainMenu() });
  });

  bot.action("btn_blacklist", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const { getBlacklist, getTokenLosses, getTokenLossesWithDates } = await import("./blacklistManager.js");
      const list = getBlacklist();
      const losses = getTokenLosses();
      const lossData = getTokenLossesWithDates();
      const WEEK = 7 * 86400000;
      const now = Date.now();
      let msg = `<b>🚫 Blacklisted: ${list.length} total</b>\n`;
      const recent = Object.entries(lossData)
        .filter(([, v]) => (v?.count ?? 0) >= 3 && v?.blacklistedAt && (now - new Date(v.blacklistedAt).getTime()) < WEEK)
        .map(([s]) => s);
      if (recent.length) msg += `<b>🆕 Recent:</b> ${recent.join(", ")}\n`;
      const auto = Object.entries(losses).filter(([, c]) => c >= 3);
      if (auto.length) msg += `<b>Auto:</b> ${auto.sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s}:${c}L`).join(" ")}\n`;
      await ctx.editMessageText(msg, { parse_mode: "HTML", ...mainMenu() });
    } catch (e) { await ctx.editMessageText(`❌ ${e.message}`, { ...mainMenu() }); }
  });

  bot.action("btn_watchlist", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const { getTokenLosses, getOORStrikes } = await import("./blacklistManager.js");
      const losses = getTokenLosses(); const oor = getOORStrikes();
      const wl = Object.entries(losses).filter(([, c]) => c > 0 && c < 3);
      const wo = Object.entries(oor).filter(([, c]) => c > 0 && c < 4);
      if (!wl.length && !wo.length) { await ctx.editMessageText("✅ No tokens on watch list", { ...mainMenu() }); return; }
      let msg = `<b>👀 Watch List</b>\n\n`;
      if (wl.length) { msg += `<b>Losses:</b>\n`; for (const [s, c] of wl.sort((a, b) => b[1] - a[1])) msg += `  ${s}: ${c}L\n`; msg += "\n"; }
      if (wo.length) { msg += `<b>OOR:</b>\n`; for (const [s, c] of wo.sort((a, b) => b[1] - a[1])) msg += `  ${s}: ${c} strikes\n`; }
      await ctx.editMessageText(msg, { parse_mode: "HTML", ...mainMenu() });
    } catch (e) { await ctx.editMessageText(`❌ ${e.message}`, { ...mainMenu() }); }
  });

  bot.action("btn_cooldown", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const { getActiveCooldowns } = await import("./cooldownManager.js");
      const { getOORCooldowns } = await import("./blacklistManager.js");
      const active = getActiveCooldowns();
      const oorCd = getOORCooldowns();
      const oorActive = Object.entries(oorCd).filter(([, v]) => new Date(v.until) > new Date());
      if (!active.length && !oorActive.length) { await ctx.editMessageText("✅ No tokens on cooldown", { ...mainMenu() }); return; }
      let msg = `<b>⏳ Cooldowns (${active.length + oorActive.length})</b>\n\n`;
      if (active.length) { for (const { symbol, remaining } of active) msg += `  ${symbol}: ${remaining}\n`; }
      if (oorActive.length) { msg += `\n<b>OOR:</b>\n`; for (const [s, v] of oorActive) { const r = Math.max(0, new Date(v.until) - Date.now()); msg += `  ${s}: ${Math.floor(r/3600000)}h ${Math.floor((r%3600000)/60000)}m\n`; } }
      await ctx.editMessageText(msg, { parse_mode: "HTML", ...mainMenu() });
    } catch (e) { await ctx.editMessageText(`❌ ${e.message}`, { ...mainMenu() }); }
  });

  bot.action("btn_logs", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("📋 Pilih kategori log:", {
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📈 PnL", "logs_pnl"), Markup.button.callback("🎯 Hunter", "logs_hunter")],
        [Markup.button.callback("💊 Healer", "logs_healer"), Markup.button.callback("🚨 Error", "logs_error")],
        [Markup.button.callback("🔄 Trades", "logs_trade"), Markup.button.callback("📊 All", "logs_all")],
        [Markup.button.callback("❌ Cancel", "logs_cancel")],
      ]),
    });
  });
  bot.action(/^logs_(.+)$/, async (ctx) => {
    const cat = ctx.match[1];
    if (cat === "cancel") { await ctx.answerCbQuery(); await ctx.editMessageText("↩️", { ...mainMenu() }); return; }
    if (cat === "live") {
      await ctx.answerCbQuery("📋 Fetching...");
      try {
        const { execSync } = await import("child_process");
        let raw = execSync("pm2 logs goyim-agent --lines 30 --nostream 2>&1", { timeout: 10000 }).toString();
        raw = raw.replace(/\x1B\[[0-9;]*[mGKH]/g, "");
        const lines = raw.split("\n")
          .map(l => l.replace(/^.*?goyim-ag\s*\|\s*/, "").trim())
          .filter(l => l.length > 0 && !l.startsWith("[TAILING]") && !l.includes("last ") && !l.includes(".pm2/logs"))
          .slice(-30);
        const timeStr = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" });
        let text = `📋 Live Logs — 30 lines\n⏰ ${timeStr} WIB\n━━━━━━━━━━━━━━━\n`;
        text += lines.join("\n");
        if (text.length > 4000) text = text.slice(-4000);
        await ctx.reply(text);
      } catch (err) { await ctx.reply(`❌ ${err.message}`); }
      return;
    }
    await ctx.answerCbQuery("📋 Fetching...");
    const keyword = cat === "all" ? null : cat;
    await sendLogs(ctx, keyword);
  });

  bot.action("btn_pnlcard", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("📊 Pilih periode PnL Card:", {
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📅 Daily", "pnlcard_daily"),
          Markup.button.callback("📆 Weekly", "pnlcard_weekly"),
          Markup.button.callback("🗓 Monthly", "pnlcard_monthly"),
        ],
        [Markup.button.callback("⬅️ Back", "pnlcard_back")],
      ]),
    });
  });
  bot.action(/^pnlcard_(.+)$/, async (ctx) => {
    const period = ctx.match[1];
    if (period === "back") { await ctx.answerCbQuery(); await ctx.deleteMessage().catch(() => {}); return; }
    await ctx.answerCbQuery("📊 Generating...");
    try {
      const { sendPnlCard } = await import("./pnlCard.js");
      await sendPnlCard(bot, ctx.chat.id, period);
    } catch (err) { await ctx.reply("❌ Gagal generate card: " + (err.message?.slice(0, 80) ?? "unknown")); }
  });

  // ── PM2 Control callbacks ─────────────────────────────────────────
  bot.action("pm2_restart", async (ctx) => {
    await ctx.answerCbQuery("🔄 Restarting...");
    try {
      const { execSync } = await import("child_process");
      await ctx.editMessageText("🔄 Restarting goyim-agent...", { ...mainMenu() });
      execSync("pm2 restart goyim-agent", { timeout: 10000 });
    } catch {}
  });

  bot.action("pm2_status", async (ctx) => {
    await ctx.answerCbQuery("⚙️ Loading...");
    try {
      const { execSync } = await import("child_process");
      const raw = execSync("pm2 jlist 2>/dev/null", { timeout: 10000 }).toString();
      const procs = JSON.parse(raw);
      const p = procs.find(x => x.name === "goyim-agent");
      if (!p) { await ctx.editMessageText("❌ Process not found", { ...mainMenu() }); return; }
      const env = p.pm2_env || {};
      const uptime = env.pm_uptime ? Math.floor((Date.now() - env.pm_uptime) / 60000) : 0;
      const uptimeH = Math.floor(uptime / 60);
      const uptimeM = uptime % 60;
      const mem = ((p.monit?.memory || 0) / 1048576).toFixed(1);
      const cpu = p.monit?.cpu ?? 0;
      const restarts = env.restart_time ?? 0;
      const status = env.status ?? "unknown";
      const statusIcon = status === "online" ? "🟢" : status === "stopped" ? "🔴" : "🟡";
      const msg =
        `<b>⚙️ PM2 Status — goyim-agent</b>\n${"─".repeat(25)}\n\n` +
        `Status: ${statusIcon} <b>${status.toUpperCase()}</b>\n` +
        `PID: <code>${p.pid ?? "?"}</code>\n` +
        `Uptime: <b>${uptimeH}h ${uptimeM}m</b>\n` +
        `Memory: <b>${mem} MB</b>\n` +
        `CPU: <b>${cpu}%</b>\n` +
        `Restarts: <b>${restarts}</b>\n` +
        `Node: <b>${env.node_version ?? "?"}</b>`;
      await ctx.editMessageText(msg, { parse_mode: "HTML", ...mainMenu() });
    } catch (err) { await ctx.editMessageText(`❌ ${err.message}`, { ...mainMenu() }); }
  });

  // ── CA Scanner callbacks ──────────────────────────────────────────
  bot.action("ca_cancel", async (ctx) => {
    await ctx.answerCbQuery("Cancelled");
    await ctx.editMessageText("↩️ Dibatalkan.", { ...mainMenu() });
  });

  bot.action(/^ca_refresh_(.+)$/, async (ctx) => {
    const mint = ctx.match[1];
    await ctx.answerCbQuery("🔄 Refreshing...");
    try {
      const { scanCA, formatCAScanMessage } = await import("./caScanner.js");
      const scan = await scanCA(mint);
      const msg = formatCAScanMessage(scan);
      const bestPool = scan.pools[0];
      const buttons = [];
      if (bestPool && scan.score >= 20) {
        buttons.push([
          Markup.button.callback("✅ Open Position", `ca_open_${bestPool.address}`),
          Markup.button.callback("❌ Skip", "ca_cancel"),
          Markup.button.callback("🔄 Refresh", `ca_refresh_${mint}`),
        ]);
      } else {
        buttons.push([
          Markup.button.callback("🔄 Refresh", `ca_refresh_${mint}`),
          Markup.button.callback("❌ Close", "ca_cancel"),
        ]);
      }
      await ctx.editMessageText(msg, { parse_mode: "HTML", disable_web_page_preview: true, ...Markup.inlineKeyboard(buttons) });
    } catch (err) { await ctx.editMessageText(`❌ ${err.message}`, { ...mainMenu() }); }
  });

  // Open position → show SOL amount selection
  bot.action(/^ca_open_(.+)$/, async (ctx) => {
    const poolAddr = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `💰 <b>Berapa SOL yang mau di-deploy?</b>\n\n🏊 Pool: <code>${poolAddr.slice(0, 10)}...</code>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([
        [
          Markup.button.callback("1 SOL", `ca_sol_1_${poolAddr}`),
          Markup.button.callback("2 SOL", `ca_sol_2_${poolAddr}`),
          Markup.button.callback("3 SOL", `ca_sol_3_${poolAddr}`),
        ],
        [Markup.button.callback("❌ Cancel", "ca_cancel")],
      ])}
    );
  });

  // SOL amount selected → show confirmation
  bot.action(/^ca_sol_(\d+)_(.+)$/, async (ctx) => {
    const solAmount = parseInt(ctx.match[1]);
    const poolAddr = ctx.match[2];
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      `⚠️ <b>Konfirmasi Open Position</b>\n\n` +
      `💰 Amount: <b>${solAmount} SOL</b>\n` +
      `🏊 Pool: <code>${poolAddr.slice(0, 10)}...</code>\n\n` +
      `Yakin mau open?`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([
        [
          Markup.button.callback("✅ Confirm & Open", `ca_confirm_${poolAddr}_${solAmount}`),
          Markup.button.callback("❌ Cancel", "ca_cancel"),
        ],
      ])}
    );
  });

  // Confirm → execute openPosition
  bot.action(/^ca_confirm_(.+)_(\d+)$/, async (ctx) => {
    const poolAddr = ctx.match[1];
    const solAmount = parseInt(ctx.match[2]);
    await ctx.answerCbQuery("⏳ Opening...");
    await ctx.editMessageText(`⏳ Opening position with ${solAmount} SOL on ${poolAddr.slice(0, 8)}...`);

    try {
      const { openPosition: openPos, getOpenPositions: getPos } = await import("./positionManager.js");
      const { recordTradeOpen } = await import("./tradeMemory.js");

      // Temporarily override maxSolPerPosition for this manual trade
      const origMax = config.maxSolPerPosition;
      config.maxSolPerPosition = solAmount;

      const decision = {
        targetPool: poolAddr,
        strategy: "spot",
        confidence: 100,
        rationale: "Manual open via CA scanner",
      };

      const posId = await openPos(decision);
      config.maxSolPerPosition = origMax;

      const newPos = getPos().find(p => p.id === posId);
      recordTradeOpen({
        positionId: posId,
        pool: poolAddr,
        poolName: newPos?.poolName ?? "manual",
        strategy: "spot",
        solDeployed: solAmount,
        positionAddress: newPos?.positionAddress,
        decision,
      });

      const txUrl = newPos?.txSignature ? `https://solscan.io/tx/${newPos.txSignature}` : null;
      let msg = `🟢 <b>APES IN! (Manual)</b>\n\n`;
      msg += `💰 <b>${solAmount} SOL</b> deployed\n`;
      msg += `🏊 Pool: <code>${poolAddr.slice(0, 10)}...</code>\n`;
      if (txUrl) msg += `\n🔗 <a href="${txUrl}">View TX ↗</a>`;

      await ctx.editMessageText(msg, { parse_mode: "HTML", ...mainMenu() });
      if (newPos) await notifyPositionOpened(newPos, decision);
    } catch (err) {
      config.maxSolPerPosition = config.maxSolPerPosition; // safety reset
      console.error("[CA] Open failed:", err.message);
      await ctx.editMessageText(`❌ Open failed: ${err.message.slice(0, 150)}`, { ...mainMenu() });
    }
  });
}

export async function notifyPositionOpened(position, decision) {
  if (!bot || !config.telegramChatId) return;
  recordPositionOpened();
  const WSOL = "So11111111111111111111111111111111111111112";

  // ── Resolve token info: try DexScreener pairs → tokens → position data ──
  let tokenSymbol = "?";
  let tokenName = "?";
  let tokenAddress = null;

  // 1) Primary: DexScreener pairs endpoint (pool address)
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${position.pool}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    const pair = data?.pair ?? data?.pairs?.[0];
    if (pair) {
      const token = (pair.baseToken?.address !== WSOL) ? pair.baseToken : pair.quoteToken;
      tokenSymbol = token?.symbol ?? "?";
      tokenName = token?.name ?? "?";
      tokenAddress = token?.address ?? null;
    }
    console.log(`[notifyOpen] DexScreener pairs: symbol=${tokenSymbol} name=${tokenName} ca=${tokenAddress?.slice(0,8)}`);
  } catch (err) {
    console.warn("[notifyOpen] DexScreener pairs failed:", err.message);
  }

  // 2) Fallback: DexScreener tokens endpoint (token mint stored in position)
  if (tokenSymbol === "?" && position.tokenMint) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${position.tokenMint}`, {
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      const pairs = (data?.pairs ?? []).filter(p => parseFloat(p.priceUsd ?? "0") > 0);
      pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const pair = pairs[0];
      if (pair) {
        const token = (pair.baseToken?.address === position.tokenMint) ? pair.baseToken : pair.quoteToken;
        tokenSymbol = token?.symbol ?? "?";
        tokenName = token?.name ?? "?";
        tokenAddress = token?.address ?? position.tokenMint;
      }
      console.log(`[notifyOpen] DexScreener tokens fallback: symbol=${tokenSymbol} name=${tokenName}`);
    } catch (err) {
      console.warn("[notifyOpen] DexScreener tokens fallback failed:", err.message);
    }
  }

  // 3) Last resort: use data stored in position from openPosition()
  if (tokenSymbol === "?") {
    tokenAddress = position.tokenMint ?? null;
    tokenSymbol = position.tokenSymbol ?? "?";
    tokenName = tokenSymbol;
    console.log(`[notifyOpen] Using stored position data: symbol=${tokenSymbol} mint=${tokenAddress?.slice(0,8)}`);
  }

  // ── Build message ───────────────────────────────────────────────────────
  const dexUrl = `https://dexscreener.com/solana/${position.pool}`;
  const txUrl = position.txSignature ? `https://solscan.io/tx/${position.txSignature}` : null;

  let msg = `🟢 <b>APES IN!</b>\n\n`;
  msg += `🪙 <b>${esc(tokenSymbol)}</b> (${esc(tokenName)})\n`;
  if (tokenAddress) {
    msg += `CA: <code>${tokenAddress}</code>\n`;
    msg += `🔍 <a href="https://solscan.io/token/${tokenAddress}">View Token ↗</a>`;
    msg += ` | 📊 <a href="${dexUrl}">DexScreener ↗</a>\n`;
  }
  msg += `\nPool: <code>${position.pool}</code>\n`;
  if (txUrl) msg += `🔗 <a href="${txUrl}">View TX ↗</a>\n`;
  msg += `\nSOL: <b>${position.solDeployed} SOL</b> | Confidence: <b>${decision.confidence}%</b>\n`;
  msg += `Strategy: <b>${esc(position.strategy)}</b>\n`;

  if (decision.ta && decision.ta.rsi !== null) {
    const emaDir = decision.ta.currentPrice >= decision.ta.ema20 ? "above" : "below";
    msg += `📊 RSI: <b>${decision.ta.rsi.toFixed(1)}</b> | EMA: <b>${emaDir}</b>\n`;
  }

  if (position.tokenCheck?.reasons?.length) {
    msg += `\n📊 ${esc(position.tokenCheck.reasons.join(" | "))}\n`;
  }

  msg += `\n💬 ${esc(decision.rationale?.slice(0, 150))}`;
  msg += `\n\n🎯 Trailing TP: aktif di +${config.trailingTpActivation}%, trail -${config.trailingTpTrail}%`;

  try {
    const { getPoolMemory } = await import("./poolMemory.js");
    const pm = getPoolMemory(position.pool);
    if (pm && pm.deployCount > 0) {
      msg += `\n📚 History: ${pm.deployCount}x deploy | WR ${pm.winRate ?? "?"}% | avg ${pm.avgPnlPct >= 0 ? "+" : ""}${pm.avgPnlPct}%`;
    }
  } catch {}

  await sendNotification(msg);
}

export async function notifyPositionClosed(positionId, reason = "agent decision", txSignatures = []) {
  if (!bot || !config.telegramChatId) return;
  recordPositionClosed();
  let msg = `🔴 <b>Position Closed</b>\n\nID: <code>${positionId}</code>\nReason: ${esc(reason)}`;
  if (txSignatures?.length > 0) {
    const links = txSignatures.map(sig => `<a href="https://solscan.io/tx/${sig}">View TX ↗</a>`).join(" | ");
    msg += `\n\n🔍 ${links}`;
  }
  await sendNotification(msg);
}

export async function notifyAgentDecision(decision) {
  if (!bot || !config.telegramChatId) return;
  updateLastDecision({ ...decision, at: new Date().toISOString() });
  if (["open", "close"].includes(decision.action)) return;
  if (decision.action === "skip" && decision.confidence < 40) return;
  const emoji = { hold: "⏸️", skip: "⏭️" }[decision.action] ?? "📊";
  await sendNotification(`${emoji} <b>${decision.action.toUpperCase()}</b> | Score: ${decision.opportunityScore ?? "?"}/100\n${esc(decision.rationale?.slice(0, 150))}`);
}

export async function notifyError(errorMsg) {
  if (!bot || !config.telegramChatId) return;
  recordError(errorMsg);
  await sendNotification(`💥 <b>Error</b>\n<code>${esc(errorMsg?.slice(0,200))}</code>`);
}

export async function notifyMessage(html) {
  if (!bot || !config.telegramChatId) return;
  await sendNotification(html);
}

export async function notifyTemporary(html, deleteAfterMs = 10000) {
  if (!bot || !config.telegramChatId) return;
  try {
    const sent = await bot.telegram.sendMessage(config.telegramChatId, html.replace(/<[^>]*>/g, ""));
    setTimeout(async () => { try { await bot.telegram.deleteMessage(config.telegramChatId, sent.message_id); } catch {} }, deleteAfterMs);
  } catch {}
}

async function sendNotification(html) {
  try {
    await bot.telegram.sendMessage(config.telegramChatId, html, { parse_mode: "HTML", ...mainMenu() });
  } catch (err) {
    // Retry without HTML parse mode if HTML parsing fails
    if (err.message?.includes("parse entities")) {
      try { await bot.telegram.sendMessage(config.telegramChatId, html.replace(/<[^>]*>/g, ""), mainMenu()); } catch {}
    }
  }
}

function buildStatusMessage() {
  const positions = getOpenPositions();
  const status = agentPaused ? "⏸️ DIJEDA" : "🔥 HUNTING";
  const d = sessionStats.lastDecision;
  let msg = `<b>🤖 Goyim Agent</b>\n${"─".repeat(25)}\n`;
  msg += `Status: <b>${status}</b> | Uptime: <b>${getUptime()}</b>\n`;
  msg += `Posisi aktif: <b>${positions.length}/${config.maxOpenPositions}</b>\n`;
  // Daily loss info
  try {
    const { trades } = getFullStats();
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const todayLoss = (trades ?? []).filter(t => t.closedAt && new Date(t.closedAt) >= todayStart && t.outcome === "loss")
      .reduce((s, t) => s + Math.abs((t.pnlPercent ?? 0) / 100 * (t.solDeployed ?? 0)), 0);
    msg += `📉 Daily Loss: <b>${todayLoss.toFixed(2)}/5 SOL</b>${todayLoss >= 5 ? " 🛑 PAUSED" : ""}\n`;
  } catch {}
  if (d) msg += `\nLast move: <b>${esc(d.action?.toUpperCase())}</b> (${d.confidence}%) — ${formatTime(d.at)}`;
  if (sessionStats.lastError) msg += `\n\n⚠️ <code>${esc(sessionStats.lastError.msg?.slice(0,80))}</code>`;
  return msg;
}

async function buildPositionsMessage(positions) {
  const WSOL = "So11111111111111111111111111111111111111112";
  let msg = `<b>📋 Open Positions (${positions.length})</b>\n━━━━━━━━━━━━━\n\n`;
  for (const pos of positions) {
    const holdH = ((Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000).toFixed(1);

    // Resolve token name: pairs endpoint → tokens endpoint → stored data
    let tokenSymbol = "?";
    let tokenName = "?";
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pos.pool}`, {
        signal: AbortSignal.timeout(6000),
      });
      const data = await res.json();
      const pair = data?.pair ?? data?.pairs?.[0];
      if (pair) {
        const token = (pair.baseToken?.address !== WSOL) ? pair.baseToken : pair.quoteToken;
        tokenSymbol = token?.symbol ?? "?";
        tokenName = token?.name ?? "?";
      }
    } catch {}

    if (tokenSymbol === "?" && pos.tokenMint) {
      try {
        const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pos.tokenMint}`, {
          signal: AbortSignal.timeout(6000),
        });
        const data = await res.json();
        const pairs = (data?.pairs ?? []).filter(p => parseFloat(p.priceUsd ?? "0") > 0);
        pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
        if (pairs[0]) {
          const token = (pairs[0].baseToken?.address === pos.tokenMint) ? pairs[0].baseToken : pairs[0].quoteToken;
          tokenSymbol = token?.symbol ?? "?";
          tokenName = token?.name ?? "?";
        }
      } catch {}
    }

    if (tokenSymbol === "?") {
      tokenSymbol = pos.tokenSymbol ?? pos.poolName?.split("-")[0] ?? "?";
      tokenName = tokenSymbol;
    }

    const pnlPct = pos.lastPnlPct;
    const pnlStr = typeof pnlPct === "number"
      ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`
      : "N/A";
    const pnlEmoji = typeof pnlPct === "number" ? (pnlPct >= 0 ? "📈" : "📉") : "📊";
    const oorStr = pos.oorSince
      ? ` ⚠️ OOR ${((Date.now() - new Date(pos.oorSince).getTime()) / 60_000).toFixed(0)}m`
      : "";

    const poolShort = pos.pool?.slice(0, 10) ?? "?";
    const meteoraUrl = `https://app.meteora.ag/dlmm/${pos.pool}`;
    const dexUrl = `https://dexscreener.com/solana/${pos.pool}`;
    const solscanUrl = pos.positionAddress ? `https://solscan.io/account/${pos.positionAddress}` : null;

    msg += `🪙 <b>${esc(tokenSymbol)}</b> (${esc(tokenName)})${oorStr}\n`;
    msg += `Pool: <a href="${meteoraUrl}">${poolShort}...</a>\n`;
    msg += `Strategy: <b>${pos.strategy?.toUpperCase()}</b> | SOL: <b>${pos.solDeployed}</b>\n`;
    msg += `${pnlEmoji} PnL: <b>${pnlStr}</b> | ⏱️ ${holdH}h\n`;
    if (pos.trailingActive) {
      const hwm = pos.highWaterMark ?? 0;
      const trail = config.trailingTpTrail ?? 3;
      const lock = (hwm - trail).toFixed(2);
      msg += `🎯 Trailing: HWM <b>+${hwm.toFixed(2)}%</b> | Lock <b>+${lock}%</b>\n`;
    }
    const links = [];
    if (solscanUrl) links.push(`🔍 <a href="${solscanUrl}">Solscan</a>`);
    links.push(`📊 <a href="${dexUrl}">DexScreener</a>`);
    msg += `${links.join(" | ")}\n\n`;
  }
  return msg;
}

function buildPnLMessage() {
  const data = getFullStats();
  const s = data?.stats ?? {};
  const totalPnl = parseFloat(s.totalPnlSol ?? 0);
  const emoji = totalPnl >= 0 ? "📈" : "📉";
  let msg = `<b>${emoji} P&L Summary</b>\n${"─".repeat(25)}\n\n`;
  msg += `Total P&L: <b>${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(4)} SOL</b>\n`;
  msg += `Avg per trade: <b>${s.avgPnlPercent ?? 0}%</b>\n\n`;
  msg += `✅ Win: <b>${s.winners ?? 0}</b> | ❌ Loss: <b>${s.losers ?? 0}</b> | ➡️ BE: <b>${s.breakeven ?? 0}</b>\n`;
  msg += `Total closed: <b>${s.totalTrades ?? 0} trades</b>\n`;
  msg += `Open now: <b>${getOpenPositions().length}/3</b>`;
  if (!s.totalTrades) msg += `\n\n<i>Belum ada closed trade.</i>`;
  return msg;
}

function buildWinRateMessage() {
  const data = getFullStats();
  const s = data?.stats ?? {};
  const ss = data?.strategyStats ?? {};
  const hitRate = parseFloat(s.hitRate ?? 0);
  const decided = (s.winners ?? 0) + (s.losers ?? 0);
  const emoji = hitRate >= 70 ? "🔥" : hitRate >= 50 ? "✅" : "⚠️";
  let msg = `<b>${emoji} Win Rate</b>\n${"─".repeat(25)}\n\n`;
  msg += `Overall: <b>${hitRate}%</b> (${s.winners ?? 0}W / ${s.losers ?? 0}L)\n`;
  msg += `Total: ${s.totalTrades ?? 0} trades | BE: ${s.breakeven ?? 0} | Unk: ${s.unknown ?? 0}\n\n`;
  msg += `<b>Per Strategy:</b>\n`;
  ["spot", "curve", "bid-ask"].forEach(strat => {
    const st = ss[strat];
    if (st?.trades > 0) msg += `• ${strat}: <b>${st.hitRate}%</b> (${st.trades} trades)\n`;
    else msg += `• ${strat}: <i>no data</i>\n`;
  });
  return msg;
}

function buildHistoryMessage() {
  const data = getFullStats();
  const trades = (data?.trades ?? []).filter(t => t.closedAt).slice(-10).reverse();
  let msg = `<b>📜 Trade History (last 10)</b>\n${"─".repeat(25)}\n\n`;
  if (trades.length === 0) { msg += `<i>Belum ada closed trade.</i>`; return msg; }
  for (const t of trades) {
    const emoji = t.outcome === "win" ? "✅" : t.outcome === "loss" ? "❌" : "➡️";
    const pnl = parseFloat(t.pnlPercent ?? 0);
    msg += `${emoji} <b>${esc(t.poolName ?? "?")}</b> | ${esc(t.strategy)}\n`;
    msg += `P&L: <b>${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%</b> | ${t.holdDurationHours}h | ${formatTime(t.closedAt)}\n\n`;
  }
  return msg;
}

async function buildLessonsMessage() {
  try {
    const { getRecentLessons } = await import("./dailyLessons.js");
    const lessons = getRecentLessons(7);
    if (lessons.length === 0) return `<b>📚 Lessons</b>\n\n<i>Belum ada data. Lesson otomatis tersimpan setiap daily report jam 7 AM WIB.</i>`;

    let msg = `<b>📚 Lessons 7 Hari Terakhir</b>\n${"━".repeat(25)}\n\n`;
    for (const l of [...lessons].reverse()) {
      const d = new Date(l.date + "T00:00:00Z");
      const day = d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", timeZone: "UTC" });
      const pnlStr = l.totalPnlSol != null ? `${l.totalPnlSol >= 0 ? "+" : ""}${l.totalPnlSol} SOL` : "?";
      msg += `📅 <b>${day}</b>: WR ${l.winRate ?? "?"}% | ${pnlStr} | ${l.tradesCount ?? 0} trades\n`;
      if (l.topWin && l.topWin !== "—") msg += `  📈 Best: ${l.topWin}`;
      if (l.worstLoss && l.worstLoss !== "—") msg += ` | 📉 Worst: ${l.worstLoss}`;
      if (l.topWin && l.topWin !== "—") msg += `\n`;
      if (l.lesson) msg += `  💡 ${esc(l.lesson)}\n`;
      msg += `\n`;
    }
    return msg;
  } catch (err) {
    return `<b>📚 Lessons</b>\n\n<i>Error: ${esc(err.message)}</i>`;
  }
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Status", "status"), Markup.button.callback("📋 Positions", "positions")],
    [Markup.button.callback("👛 Wallet", "wallet"), Markup.button.callback("🏆 Win Rate", "winrate")],
    [Markup.button.callback("📜 History", "history"), Markup.button.callback("📋 Daily Review", "review"), Markup.button.callback("📚 Lessons", "lessons")],
    [Markup.button.callback("🔄 Refresh", "refresh")],
    [Markup.button.callback("🚫 Blacklist", "btn_blacklist"), Markup.button.callback("👀 Watchlist", "btn_watchlist")],
    [Markup.button.callback("⏳ Cooldown", "btn_cooldown"), Markup.button.callback("📋 Logs", "btn_logs")],
    [Markup.button.callback("📊 PnL Card", "btn_pnlcard")],
    [Markup.button.callback("🔄 Restart", "pm2_restart"), Markup.button.callback("⚙️ PM2 Status", "pm2_status")],
    [
      agentPaused ? Markup.button.callback("▶️ Resume", "resume") : Markup.button.callback("⏸️ Pause", "pause"),
      Markup.button.callback("🔴 Close All", "closeall_confirm_prompt"),
    ],
  ]);
}

function resumeMenu() {
  return Markup.inlineKeyboard([[Markup.button.callback("▶️ Resume", "resume"), Markup.button.callback("📊 Status", "status")]]);
}

function confirmCloseAllMenu() {
  return Markup.inlineKeyboard([[Markup.button.callback("✅ Ya, close!", "closeall_yes"), Markup.button.callback("❌ Batal", "closeall_no")]]);
}

function positionsMenu(positions) {
  const btns = positions.map(pos => [Markup.button.callback(`🔴 Close ${pos.pool?.slice(0,6)}...`, `close_${pos.id}`)]);
  return Markup.inlineKeyboard([...btns, [Markup.button.callback("↩️ Back", "status")]]);
}

function getUptime() {
  const ms = Date.now() - new Date(sessionStats.startedAt).getTime();
  return `${Math.floor(ms / 3_600_000)}j ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

function formatTime(iso) {
  if (!iso) return "N/A";
  return new Date(iso).toLocaleString("id-ID", { timeZone: "Asia/Jakarta", dateStyle: "short", timeStyle: "short" });
}



