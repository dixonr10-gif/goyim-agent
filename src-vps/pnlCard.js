// src/pnlCard.js — Generate PnL card PNG via node-canvas
import { createRequire } from "module";
import { getFullStats } from "./tradeMemory.js";
import { getOpenPositions } from "./positionManager.js";
import { getPortfolioStats } from "./meteoraPnl.js";

const require = createRequire(import.meta.url);

// ── Helpers ─────────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fmtUsd(n) {
  if (Math.abs(n) >= 1000) return (n >= 0 ? "+" : "") + "$" + (n / 1000).toFixed(1) + "K";
  return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2);
}

// ── Data (Meteora API first, local fallback) ────────────────────────
async function getCardDataMeteora(period) {
  const stats = await getPortfolioStats(period);
  if (!stats || stats.totalPools === 0) return null;
  const openPos = getOpenPositions().length;
  return {
    period, dateRange: `${stats.startDate} — ${stats.endDate}`,
    days: stats.days, openPositions: openPos,
    summary: {
      totalPnlUsd: stats.totalPnlUsd,
      totalPositions: stats.totalPools,
      wins: stats.wins, winRate: stats.winRate,
      activeDays: stats.days.length,
    },
    allStats: {
      totalTrades: stats.totalPools,
      hitRate: stats.winRate,
      wins: stats.wins,
      losses: stats.losses,
      totalPnlSol: stats.totalPnlSol?.toFixed(4) ?? "0",
      totalFeesUsd: stats.totalFeesUsd?.toFixed(2) ?? "0",
      bestPool: stats.bestPool ? `${stats.bestPool.name} ${fmtUsd(stats.bestPool.pnlUsd)}` : null,
      worstPool: stats.worstPool ? `${stats.worstPool.name} ${fmtUsd(stats.worstPool.pnlUsd)}` : null,
    },
    source: "meteora",
  };
}

function getCardDataLocal(period) {
  const { trades, stats } = getFullStats();
  const closed = trades.filter(t => t.closedAt);
  const now = new Date();
  let startDate;
  if (period === "daily") {
    startDate = new Date(now); startDate.setUTCHours(0, 0, 0, 0);
  } else if (period === "monthly") {
    startDate = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
  } else {
    startDate = new Date(now.getTime() - 7 * 86400000); startDate.setUTCHours(0, 0, 0, 0);
  }
  const filtered = closed.filter(t => new Date(t.closedAt) >= startDate);
  const dayMap = {};
  for (const t of filtered) {
    const d = t.closedAt.slice(0, 10);
    if (!dayMap[d]) dayMap[d] = { date: d, pnlUsd: 0, positions: 0, wins: 0, losses: 0 };
    dayMap[d].pnlUsd += (parseFloat(t.pnlPercent ?? 0) / 100) * (t.solDeployed ?? 0) * (t.solPriceAtEntry ?? 80);
    dayMap[d].positions++;
    if (t.outcome === "win") dayMap[d].wins++;
    if (t.outcome === "loss") dayMap[d].losses++;
  }
  const days = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));
  const totalPos = filtered.length;
  const wins = filtered.filter(t => t.outcome === "win").length;
  const openPos = getOpenPositions().length;
  return {
    period, dateRange: `${startDate.toISOString().slice(0,10)} — ${now.toISOString().slice(0,10)}`,
    days, openPositions: openPos,
    summary: { totalPnlUsd: days.reduce((s, d) => s + d.pnlUsd, 0), totalPositions: totalPos, wins, winRate: totalPos > 0 ? ((wins / totalPos) * 100).toFixed(0) : "0", activeDays: days.length },
    allStats: stats, source: "local",
  };
}

async function getCardData(period = "weekly") {
  try {
    const meteora = await getCardDataMeteora(period);
    if (meteora) return meteora;
  } catch (err) {
    console.log(`[PnlCard] Meteora fallback: ${err.message}`);
  }
  return getCardDataLocal(period);
}

// ── Canvas ──────────────────────────────────────────────────────────
function generatePnlCard(data) {
  const { createCanvas } = require("canvas");
  const W = 520, H = 580;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background
  roundRect(ctx, 0, 0, W, H, 16);
  ctx.fillStyle = "#0d0d0d";
  ctx.fill();

  // ── Header ──────────────────────────────────────────────────────
  // Avatar circle
  ctx.beginPath(); ctx.arc(46, 38, 20, 0, Math.PI * 2);
  ctx.fillStyle = "#1a1a2e"; ctx.fill();
  ctx.font = "bold 14px sans-serif"; ctx.fillStyle = "#4ade80";
  ctx.textAlign = "center"; ctx.fillText("AG", 46, 43);
  ctx.textAlign = "left";

  ctx.font = "bold 15px sans-serif"; ctx.fillStyle = "#ffffff";
  ctx.fillText("Agent Goyim", 78, 34);
  ctx.font = "11px sans-serif"; ctx.fillStyle = "#555555";
  ctx.fillText("solana.dlmm.bot", 78, 50);

  // Right stats
  ctx.textAlign = "right";
  ctx.font = "11px sans-serif"; ctx.fillStyle = "#555555";
  ctx.fillText(`${data.summary.totalPositions} positions`, W - 24, 34);
  ctx.fillText(`${data.openPositions} active`, W - 24, 50);
  ctx.textAlign = "left";

  // ── Tabs ─────────────────────────────────────────────────────────
  const tabs = ["Daily", "Weekly", "Monthly"];
  const tabY = 72;
  let tabX = 24;
  for (const tab of tabs) {
    const active = tab.toLowerCase() === data.period;
    const tw = ctx.measureText(tab).width + 24;
    roundRect(ctx, tabX, tabY, tw, 26, 13);
    if (active) { ctx.fillStyle = "#ffffff"; ctx.fill(); }
    else { ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.font = "11px sans-serif";
    ctx.fillStyle = active ? "#000000" : "#555555";
    ctx.fillText(tab, tabX + 12, tabY + 17);
    tabX += tw + 8;
  }

  // ── Period & PnL ────────────────────────────────────────────────
  ctx.font = "bold 18px sans-serif"; ctx.fillStyle = "#ffffff";
  ctx.fillText(data.dateRange, 24, 128);
  ctx.font = "11px sans-serif"; ctx.fillStyle = "#555555";
  ctx.fillText(`${data.summary.activeDays} days  ·  ${data.summary.totalPositions} trades  ·  WR ${data.summary.winRate}%`, 24, 146);

  const pnl = data.summary.totalPnlUsd;
  const isProfit = pnl >= 0;
  ctx.font = "bold 28px sans-serif";
  ctx.fillStyle = isProfit ? "#4ade80" : "#f87171";
  ctx.fillText(fmtUsd(pnl), 24, 184);

  // ── Calendar grid ───────────────────────────────────────────────
  const gridY = 206;
  const cellW = 62, cellH = 64, gap = 4;
  const gridX = 24;
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  ctx.font = "9px sans-serif"; ctx.fillStyle = "#444444";
  for (let i = 0; i < 7; i++) {
    ctx.fillText(dayLabels[i], gridX + i * (cellW + gap) + 4, gridY - 4);
  }

  // Build calendar cells — last 5 weeks or current period
  const dayDataMap = {};
  for (const d of data.days) dayDataMap[d.date] = d;

  const endDate = new Date();
  const startOffset = endDate.getUTCDay(); // 0=Sun
  const calStart = new Date(endDate.getTime() - (startOffset + 28) * 86400000);
  calStart.setUTCHours(0, 0, 0, 0);

  let row = 0;
  const calDate = new Date(calStart);
  for (let i = 0; i < 35; i++) {
    const col = calDate.getUTCDay();
    if (i > 0 && col === 0) row++;
    const dateStr = calDate.toISOString().slice(0, 10);
    const dayData = dayDataMap[dateStr];
    const cx = gridX + col * (cellW + gap);
    const cy = gridY + row * (cellH + gap);

    // Cell background
    roundRect(ctx, cx, cy, cellW, cellH, 6);
    if (dayData) {
      ctx.fillStyle = dayData.pnlUsd >= 0 ? "#0d2b1a" : "#2b0d0d";
    } else {
      ctx.fillStyle = "#111111";
    }
    ctx.fill();
    ctx.strokeStyle = dayData ? (dayData.pnlUsd >= 0 ? "#1a4a2e" : "#4a1a1a") : "#1a1a1a";
    ctx.lineWidth = 1; ctx.stroke();

    // Date number
    ctx.font = "9px sans-serif"; ctx.fillStyle = "#444444";
    ctx.fillText(String(calDate.getUTCDate()), cx + 4, cy + 12);

    if (dayData) {
      // PnL
      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = dayData.pnlUsd >= 0 ? "#4ade80" : "#f87171";
      ctx.fillText(fmtUsd(dayData.pnlUsd), cx + 4, cy + cellH - 18);
      // Positions
      ctx.font = "9px sans-serif"; ctx.fillStyle = "#555555";
      ctx.fillText(`${dayData.positions}pos`, cx + 4, cy + cellH - 6);
    }

    calDate.setDate(calDate.getDate() + 1);
  }

  // ── Divider ─────────────────────────────────────────────────────
  const divY = gridY + 5 * (cellH + gap) + 12;
  ctx.beginPath(); ctx.moveTo(24, divY); ctx.lineTo(W - 24, divY);
  ctx.strokeStyle = "#1a1a1a"; ctx.lineWidth = 1; ctx.stroke();

  // ── Stats grid ──────────────────────────────────────────────────
  const statY = divY + 16;
  const stats = data.allStats ?? {};
  const feesVal = stats.totalFeesUsd ? `$${parseFloat(stats.totalFeesUsd).toLocaleString("en", { maximumFractionDigits: 0 })}` : "$0";
  const statItems = [
    { label: "WIN RATE", value: `${stats.hitRate ?? 0}%  (W:${stats.wins ?? 0} L:${stats.losses ?? 0})`, color: "#4ade80" },
    { label: "FEES EARNED", value: feesVal, color: "#facc15" },
    { label: "BEST POOL", value: stats.bestPool ?? "—", color: "#4ade80" },
    { label: "WORST POOL", value: stats.worstPool ?? "—", color: "#f87171" },
  ];
  for (let i = 0; i < statItems.length; i++) {
    const sx = 24 + (i % 2) * 240;
    const sy = statY + Math.floor(i / 2) * 36;
    ctx.font = "9px sans-serif"; ctx.fillStyle = "#444444";
    ctx.fillText(statItems[i].label, sx, sy);
    ctx.font = "bold 13px sans-serif"; ctx.fillStyle = statItems[i].color ?? "#cccccc";
    ctx.fillText(String(statItems[i].value).slice(0, 28), sx, sy + 18);
  }

  // ── Source + Timestamp ──────────────────────────────────────────
  const srcLabel = data.source === "meteora" ? "Meteora (fees included)" : "local";
  ctx.textAlign = "right"; ctx.font = "9px sans-serif"; ctx.fillStyle = "#333333";
  ctx.fillText(`${srcLabel}  ·  ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, W - 24, H - 12);
  ctx.textAlign = "left";

  return canvas.toBuffer("image/png");
}

// ── Fabriq URL helper ──────────────────────────────────────────────
async function getFabriqUrl() {
  try {
    const { getWalletAddress } = await import("./walletInfo.js");
    const addr = await getWalletAddress();
    return `https://fabriq.trade/portfolio-beta?walletAddress=${addr}`;
  } catch { return null; }
}

// ── Public API ──────────────────────────────────────────────────────
export async function sendPnlCard(bot, chatId, period = "weekly") {
  try {
    const data = await getCardData(period);
    const buffer = generatePnlCard(data);
    const fabriqUrl = await getFabriqUrl();
    const src = data.source === "meteora" ? " (Meteora)" : "";
    const caption = `📊 Agent Goyim — ${period} PnL${src}` +
      (fabriqUrl ? `\n🔍 Detail: ${fabriqUrl}` : "");
    const { Markup } = await import("telegraf");
    const keyboard = fabriqUrl
      ? { reply_markup: Markup.inlineKeyboard([[Markup.button.url("📈 View on Fabriq", fabriqUrl)]]).reply_markup }
      : {};
    await bot.telegram.sendPhoto(chatId, { source: buffer }, { caption, ...keyboard });
  } catch (err) {
    console.log(`[PnlCard] Error: ${err.message}`);
    try {
      const data = await getCardData(period);
      const s = data.summary;
      await bot.telegram.sendMessage(chatId,
        `📊 <b>PnL ${period}</b>\n${data.dateRange}\n\nTrades: ${s.totalPositions} | WR: ${s.winRate}% | PnL: ${fmtUsd(s.totalPnlUsd)}`,
        { parse_mode: "HTML" }
      );
    } catch {}
  }
}

export { getCardData, generatePnlCard };
