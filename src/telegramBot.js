import { Telegraf, Markup } from "telegraf";
import { config } from "../config.js";
import { getOpenPositions, closePosition, getPositionValue } from "./positionManager.js";
import { getFullStats } from "./tradeMemory.js";
import { getSOLBalance, getTokenBalances, getWalletAddress, formatWalletMessage } from "./walletInfo.js";

let bot;
let agentPaused = false;
let sessionStats = {
  totalOpened: 0,
  totalClosed: 0,
  startedAt: new Date().toISOString(),
  lastDecision: null,
  lastError: null,
};

export function initTelegramBot() {
  if (!config.telegramBotToken) return null;
  bot = new Telegraf(config.telegramBotToken);
  registerCommands();
  registerCallbacks();
  bot.catch((err) => console.error("Telegraf error:", err.message));
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
      const [sol, tokens] = await Promise.all([getSOLBalance(address), getTokenBalances(address)]);
      await ctx.replyWithHTML(formatWalletMessage(address, sol, tokens), mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("pnl", async (ctx) => { await ctx.replyWithHTML(buildPnLMessage(), mainMenu()); });
  bot.command("winrate", async (ctx) => { await ctx.replyWithHTML(buildWinRateMessage(), mainMenu()); });
  bot.command("history", async (ctx) => { await ctx.replyWithHTML(buildHistoryMessage(), mainMenu()); });

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
      await ctx.replyWithHTML(`<b>📋 Daily Review</b>\n\n${review}`, mainMenu());
    } catch (err) { await ctx.reply(`❌ ${err.message}`); }
  });

  bot.command("help", async (ctx) => {
    await ctx.replyWithHTML(
      `<b>📖 Commands:</b>\n\n` +
      `/status — Status agent\n/wallet — Saldo wallet\n/pnl — P&L summary\n` +
      `/winrate — Win rate\n/history — Riwayat trade\n/positions — Posisi aktif\n` +
      `/review — Daily review\n/pause & /resume — Jeda/lanjut\n/closeall — Tutup semua\n\n` +
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
    const reply = await chatWithGoyimVision(userId, caption, base64);
    await ctx.reply(reply);
  } catch (err) {
    console.error("[PHOTO] Error:", err.message);
    await ctx.reply("Gagal proses foto bro: " + err.message.slice(0, 100));
  }
});
// CHAT HANDLER - inside registerCommands so bot is defined
  bot.on("text", async (ctx) => {
    console.log("[CHAT] Incoming:", ctx.message?.text);
    if (!ctx.message?.text || ctx.message.text.startsWith("/")) return;
    const userId = String(ctx.from.id);
    try {
      await ctx.sendChatAction("typing");
      const { chatWithGoyim } = await import("./goyimChat.js");
      console.log("[CHAT] Calling chatWithGoyim...");
      const reply = await chatWithGoyim(userId, ctx.message.text);
      console.log("[CHAT] Reply:", reply?.slice(0, 80));
      await ctx.reply(reply);
    } catch (err) {
      console.error("[CHAT] Error:", err.message);
      await ctx.reply("Error bro: " + err.message.slice(0, 100));
    }
  });
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
      const [sol, tokens] = await Promise.all([getSOLBalance(address), getTokenBalances(address)]);
      await ctx.editMessageText(formatWalletMessage(address, sol, tokens), { parse_mode: "HTML", ...mainMenu() });
    } catch (err) { await ctx.editMessageText(`❌ ${err.message}`, { ...mainMenu() }); }
  });
  bot.action("pnl", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(buildPnLMessage(), { parse_mode: "HTML", ...mainMenu() });
  });
  bot.action("winrate", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(buildWinRateMessage(), { parse_mode: "HTML", ...mainMenu() });
  });
  bot.action("history", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(buildHistoryMessage(), { parse_mode: "HTML", ...mainMenu() });
  });
  bot.action("positions", async (ctx) => {
    await ctx.answerCbQuery("⏳");
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
      await ctx.editMessageText(`<b>📋 Daily Review</b>\n\n${review}`, { parse_mode: "HTML", ...mainMenu() });
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
    let closed = 0;
    for (const pos of positions) { try { await closePosition(pos.id); closed++; } catch {} }
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
      await closePosition(posId);
      await ctx.editMessageText(`✅ Posisi closed!`, { ...mainMenu() });
    } catch (err) { await ctx.editMessageText(`❌ ${err.message}`, { ...mainMenu() }); }
  });
  bot.action("refresh", async (ctx) => {
    await ctx.answerCbQuery("🔄");
    await ctx.editMessageText(buildStatusMessage(), { parse_mode: "HTML", ...mainMenu() });
  });
}

export async function notifyPositionOpened(position, decision) {
  if (!bot || !config.telegramChatId) return;
  recordPositionOpened();
  const poolShort = position.pool?.slice(0, 8);
  const poolUrl = `https://app.meteora.ag/dlmm/${position.pool}`;
  const dexUrl = `https://dexscreener.com/solana/${position.pool}`;
  const txUrl = position.txSignature ? `https://solscan.io/tx/${position.txSignature}` : null;

  const tokenSymbol = position.pool ? position.tokenCheck?.dexData?.baseToken?.symbol ?? "?" : "?";
  const tokenName = position.tokenCheck?.dexData?.baseToken?.name ?? "?";
  const tokenAddress = position.tokenCheck?.dexData?.baseToken?.address ?? "?";
  const solscanToken = `https://solscan.io/token/${tokenAddress}`;

  let msg = `🟢 <b>APES IN!</b>\n\n`;
  msg += `🪙 <b>${tokenName}</b> (<code>${tokenSymbol}</code>)\n`;
  msg += `CA: <code>${tokenAddress}</code>\n`;
  msg += `<a href="${solscanToken}">View Token ↗</a>\n\n`;
  msg += `Pool: <a href="${poolUrl}">${poolShort}...</a> | <a href="${dexUrl}">DexScreener ↗</a>\n`;
  msg += `Strategy: <b>${position.strategy}</b>\n`;
  msg += `SOL: <b>${position.solDeployed} SOL</b>\n`;
  msg += `Confidence: <b>${decision.confidence}%</b>\n`;

  if (position.tokenCheck) {
    const t = position.tokenCheck;
    msg += `\n📊 <b>Token Info:</b>\n`;
    msg += `${t.reasons?.join(" | ") ?? ""}\n`;
  }

  msg += `\n💬 ${decision.rationale?.slice(0, 150)}\n`;

  if (txUrl) {
    msg += `\n🔗 <a href="${txUrl}">View TX on Solscan ↗</a>`;
  }

  await sendNotification(msg);
}

export async function notifyPositionClosed(positionId, reason = "agent decision") {
  if (!bot || !config.telegramChatId) return;
  recordPositionClosed();
  await sendNotification(`🔴 <b>Position Closed</b>\n\nID: <code>${positionId}</code>\nReason: ${reason}`);
}

export async function notifyAgentDecision(decision) {
  if (!bot || !config.telegramChatId) return;
  updateLastDecision({ ...decision, at: new Date().toISOString() });
  if (["open", "close"].includes(decision.action)) return;
  if (decision.action === "skip" && decision.confidence < 40) return;
  const emoji = { hold: "⏸️", skip: "⏭️" }[decision.action] ?? "📊";
  await sendNotification(`${emoji} <b>${decision.action.toUpperCase()}</b> | Score: ${decision.opportunityScore ?? "?"}/100\n${decision.rationale?.slice(0, 150)}`);
}

export async function notifyError(errorMsg) {
  if (!bot || !config.telegramChatId) return;
  recordError(errorMsg);
  await sendNotification(`💥 <b>Error</b>\n<code>${errorMsg?.slice(0,200)}</code>`);
}

async function sendNotification(html) {
  try {
    await bot.telegram.sendMessage(config.telegramChatId, html, { parse_mode: "HTML", ...mainMenu() });
  } catch (err) { console.error("Telegram send error:", err.message); }
}

function buildStatusMessage() {
  const positions = getOpenPositions();
  const status = agentPaused ? "⏸️ DIJEDA" : "🔥 HUNTING";
  const d = sessionStats.lastDecision;
  let msg = `<b>🤖 Goyim Agent</b>\n${"─".repeat(25)}\n`;
  msg += `Status: <b>${status}</b> | Uptime: <b>${getUptime()}</b>\n`;
  msg += `Posisi aktif: <b>${positions.length}/3</b>\n`;
  if (d) msg += `\nLast move: <b>${d.action?.toUpperCase()}</b> (${d.confidence}%) — ${formatTime(d.at)}`;
  if (sessionStats.lastError) msg += `\n\n⚠️ <code>${sessionStats.lastError.msg?.slice(0,80)}</code>`;
  return msg;
}

async function buildPositionsMessage(positions) {
  let msg = `<b>📋 Open Positions (${positions.length})</b>\n${"─".repeat(25)}\n\n`;
  for (const pos of positions) {
    const holdH = ((Date.now() - new Date(pos.openedAt).getTime()) / 3_600_000).toFixed(1);
    let pnlStr = "";
    try {
      const currentVal = await getPositionValue(pos);
      if (currentVal != null && pos.solDeployed > 0) {
        const pnl = currentVal - pos.solDeployed;
        const pnlPct = ((pnl / pos.solDeployed) * 100).toFixed(1);
        const arrow = pnl >= 0 ? "📈" : "📉";
        pnlStr = ` | ${arrow} <b>${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL (${pnl >= 0 ? "+" : ""}${pnlPct}%)</b>`;
      }
    } catch {}
    msg += `<b>${pos.strategy?.toUpperCase()}</b> | <code>${pos.pool?.slice(0, 10)}...</code>\n`;
    msg += `💰 ${pos.solDeployed} SOL${pnlStr} | ⏱️ ${holdH}h\n`;
    if (pos.binRange?.lower != null) msg += `📊 Bins: ${pos.binRange.lower}–${pos.binRange.upper}\n`;
    if (pos.txSignature) msg += `<a href="https://solscan.io/tx/${pos.txSignature}">Solscan ↗</a>\n`;
    msg += `\n`;
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
  const emoji = hitRate >= 70 ? "🔥" : hitRate >= 50 ? "✅" : "⚠️";
  let msg = `<b>${emoji} Win Rate</b>\n${"─".repeat(25)}\n\n`;
  msg += `Overall: <b>${hitRate}%</b> (${s.winners ?? 0}/${s.totalTrades ?? 0})\n\n`;
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
    msg += `${emoji} <b>${t.poolName ?? "?"}</b> | ${t.strategy}\n`;
    msg += `P&L: <b>${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%</b> | ${t.holdDurationHours}h | ${formatTime(t.closedAt)}\n\n`;
  }
  return msg;
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Status", "status"), Markup.button.callback("📋 Positions", "positions")],
    [Markup.button.callback("👛 Wallet", "wallet"), Markup.button.callback("📈 P&L", "pnl")],
    [Markup.button.callback("🏆 Win Rate", "winrate"), Markup.button.callback("📜 History", "history")],
    [Markup.button.callback("📋 Daily Review", "review"), Markup.button.callback("🔄 Refresh", "refresh")],
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



