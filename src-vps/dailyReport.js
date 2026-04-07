// src/dailyReport.js — Daily PnL report at 7 AM WIB (UTC+7)

import { getFullStats } from "./tradeMemory.js";
import { getOpenPositions } from "./positionManager.js";
import { getSOLBalance, getWalletAddress, getSolPriceUSD } from "./walletInfo.js";
import { saveDailyLesson } from "./dailyLessons.js";

function getNext7amWIB() {
  const now = new Date();
  // WIB = UTC+7, so 7AM WIB = 00:00 UTC
  const next = new Date();
  next.setUTCHours(0, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next;
}

function formatDate() {
  return new Date().toLocaleDateString("id-ID", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Asia/Jakarta",
  });
}

export async function generateDailyPnLReport() {
  try {
    const { stats, trades } = getFullStats();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    todayStart.setDate(todayStart.getDate() - 1); // last 24h

    const todayTrades = trades.filter(t => t.closedAt && new Date(t.closedAt) >= todayStart);
    const wins = todayTrades.filter(t => t.outcome === "win");
    const losses = todayTrades.filter(t => t.outcome === "loss");

    let pnlUsdToday = 0;
    let feesEarned = 0;
    let bestTrade = null;
    let worstTrade = null;

    for (const t of todayTrades) {
      const pnlPct = parseFloat(t.pnlPercent ?? 0);
      const solDeployed = t.solDeployed ?? 0;
      const solPrice = t.solPriceAtEntry ?? 80;
      pnlUsdToday += (pnlPct / 100) * solDeployed * solPrice;

      if (!bestTrade || pnlPct > parseFloat(bestTrade.pnlPercent ?? 0)) bestTrade = t;
      if (!worstTrade || pnlPct < parseFloat(worstTrade.pnlPercent ?? 0)) worstTrade = t;
    }

    // Wallet balance
    let solBal = 0, solPrice = 0;
    try {
      const addr = await getWalletAddress();
      [solBal, solPrice] = await Promise.all([getSOLBalance(addr), getSolPriceUSD()]);
    } catch {}

    const openPos = getOpenPositions();
    const wr = todayTrades.length > 0 ? ((wins.length / todayTrades.length) * 100).toFixed(0) : "N/A";
    const pnlPctOverall = solBal > 0 && solPrice > 0 && todayTrades.length > 0
      ? ((pnlUsdToday / (solBal * solPrice)) * 100).toFixed(2) : "0.00";

    const bestName = bestTrade?.poolName?.split("-")[0] ?? "—";
    const worstName = worstTrade?.poolName?.split("-")[0] ?? "—";
    const bestPnl = bestTrade ? `+${parseFloat(bestTrade.pnlPercent).toFixed(1)}%` : "—";
    const worstPnl = worstTrade ? `${parseFloat(worstTrade.pnlPercent).toFixed(1)}%` : "—";

    let msg = `📊 <b>Daily Report — Goyim Agent</b>\n━━━━━━━━━━━━━━━\n`;
    msg += `📅 ${formatDate()}\n\n`;
    msg += `💰 PnL Hari Ini: <b>${pnlUsdToday >= 0 ? "+" : ""}$${pnlUsdToday.toFixed(2)}</b> (${pnlPctOverall}%)\n`;
    msg += `🏆 Win Rate: <b>${wr}%</b> (${wins.length} win / ${losses.length} loss)\n`;
    msg += `📈 Best Trade: <b>${bestName} ${bestPnl}</b>\n`;
    msg += `📉 Worst Trade: <b>${worstName} ${worstPnl}</b>\n`;
    msg += `🔄 Total Trades: <b>${todayTrades.length}</b>\n\n`;
    msg += `💼 Wallet: <b>${solBal.toFixed(2)} SOL</b> ($${(solBal * solPrice).toFixed(0)} USD)\n`;
    msg += `📊 Open Positions: <b>${openPos.length}</b>`;

    // Save daily lesson for /lessons command
    try {
      const totalPnlSol = todayTrades.reduce((a, t) => a + ((parseFloat(t.pnlPercent ?? 0) / 100) * (t.solDeployed ?? 0)), 0);
      const lessonText = todayTrades.length === 0
        ? "No trades today"
        : todayTrades.length <= 2
          ? `Low activity: only ${todayTrades.length} trade(s). Need more pool diversity.`
          : parseFloat(wr) >= 60
            ? `Good day — WR ${wr}% with ${todayTrades.length} trades. Keep current strategy.`
            : `WR ${wr}% below target. Review pool selection and entry timing.`;
      saveDailyLesson({
        winRate: parseFloat(wr) || 0,
        totalPnlSol: parseFloat(totalPnlSol.toFixed(4)),
        topWin: bestPnl,
        worstLoss: worstPnl,
        tradesCount: todayTrades.length,
        lesson: lessonText,
        planBesok: parseFloat(wr) >= 50 ? "Continue current approach" : "Widen pool scan, review blacklist",
      });
    } catch {}

    return msg;
  } catch (err) {
    console.error("[DailyReport] Error:", err.message);
    return `📊 Daily Report — Error: ${err.message}`;
  }
}

let _reportStarted = false;

export function startDailyPnLReport(bot, chatId) {
  if (_reportStarted || !bot || !chatId) return;
  _reportStarted = true;

  async function scheduleNext() {
    const next = getNext7amWIB();
    const delay = next.getTime() - Date.now();
    console.log(`📊 Daily PnL report dijadwal: ${next.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`);

    setTimeout(async () => {
      try {
        console.log("📊 Generating daily PnL report...");
        const report = await generateDailyPnLReport();
        await bot.telegram.sendMessage(chatId, report, { parse_mode: "HTML" });
        console.log("✅ Daily PnL report sent!");
      } catch (err) {
        console.error("❌ DailyReport send error:", err.message);
      }
      scheduleNext();
    }, delay);
  }

  scheduleNext();
}
