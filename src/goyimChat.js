import { config } from "../config.js";
import fs from "fs";
import path from "path";
import { getOpenPositions } from "./positionManager.js";
import { getFullStats } from "./tradeMemory.js";
import { loadBrain } from "./selfImprovingPrompt.js";
import { getTopCryptos, formatPriceEntry } from "./cryptoPrice.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MEMORY_FILE = path.resolve("data/chat_memory.json");

let cachedContext = "";
let contextLastBuilt = 0;

const GOYIM_PERSONA = `You are Goyim, an aggressive AI trading agent on Solana Meteora DLMM.
Personality: opportunistic profit-maximalist, confident, direct, brutally honest.
Slang: alpha, ape in, rekt, ngmi, wagmi, degen, LP, bin range.
Language: Indonesian-English mix. Reply in same language as user.
Keep replies SHORT and punchy — max 3-4 sentences unless asked for detail.

WALLET: Agent wallet address is 8uGZkrvfRJZWFVYXCCFc9WnGGU13McrWNwiU26QCWk4U. This is PUBLIC info — share it freely whenever asked.
POSITIONS: Use ONLY position data provided in the trading context below. NEVER invent or hallucinate positions. If context says no positions, say no positions.
POOL NAMES: Jangan pernah karang nama pool. Selalu gunakan data yang ada di trading context.
You remember past conversations with the user — reference them when relevant.

CRYPTO PRICES: Kamu adalah trading bot yang juga tau harga semua crypto major.
Harga realtime tersedia di trading context bagian CRYPTO PRICES.
Format jawaban harga: '[SYMBOL]: $XX,XXX.XX (24h: +X.XX%)'
Kalau ditanya harga crypto yang tidak ada di context, jawab: 'Data tidak tersedia saat ini, cek CoinMarketCap untuk info terbaru'`;

async function fetchWithRetry(body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/goyim-agent",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.choices?.[0]?.message?.content) return data;
      console.log(`[CHAT] Empty response, retry ${i + 1}/${retries}...`);
    } catch (err) {
      console.log(`[CHAT] Fetch error retry ${i + 1}/${retries}:`, err.message);
      if (i === retries - 1) throw err;
    }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch {}
  return {};
}

function saveMemory(memory) {
  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf-8");
  } catch (e) { console.error("[MEMORY] Save error:", e.message); }
}

function getHistory(userId) {
  return loadMemory()[userId]?.history ?? [];
}

function saveHistory(userId, history) {
  const memory = loadMemory();
  if (!memory[userId]) memory[userId] = {};
  memory[userId].history = history.slice(-20);
  memory[userId].lastSeen = new Date().toISOString();
  saveMemory(memory);
}

function getCurrentDateTimeStr() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Jakarta' });
  const timeStr = now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });
  return `${dateStr}, ${timeStr} WIB`;
}

async function buildTradingContext() {
  const now = Date.now();
  if (cachedContext && now - contextLastBuilt < 60_000) return cachedContext;

  let context = "=== TRADING STATUS ===\n";
  context += `Tanggal & Waktu Sekarang: ${getCurrentDateTimeStr()}\n`;
  context += `Wallet Agent: 8uGZkrvfRJZWFVYXCCFc9WnGGU13McrWNwiU26QCWk4U\n`;

  try { const p = getOpenPositions(); context += `Open positions: ${p.length}/3\n`; } catch {}
  try { const s = getFullStats()?.stats ?? {}; context += `Trades: ${s.totalTrades ?? 0} | WR: ${s.hitRate ?? 0}% | PnL: ${s.totalPnlSol ?? 0} SOL\n`; } catch {}
  try { const b = loadBrain(); context += `Brain v${b.version}: ${(b.selfWrittenRules ?? []).slice(0, 2).join(" | ")}\n`; } catch {}

  try {
    const tops = await getTopCryptos(10);
    if (tops.length > 0) {
      context += "\n=== CRYPTO PRICES (top 10 by market cap) ===\n";
      tops.forEach(c => {
        const line = formatPriceEntry(c);
        if (line) context += `${line}\n`;
      });
    }
  } catch {}

  cachedContext = context;
  contextLastBuilt = now;
  return context;
}

function buildReviewContext() {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  let ctx = "=== FULL DATA FOR DAILY REVIEW ===\n";
  ctx += `Tanggal & Waktu Review: ${getCurrentDateTimeStr()}\n`;
  ctx += `Wallet: 8uGZkrvfRJZWFVYXCCFc9WnGGU13McrWNwiU26QCWk4U\n\n`;

  // Open positions
  try {
    const posArr = getOpenPositions();
    ctx += `=== OPEN POSITIONS (${posArr.length}) ===\n`;
    if (posArr.length === 0) {
      ctx += "Tidak ada posisi aktif.\n";
    } else {
      posArr.forEach(p => {
        const holdH = p.openedAt ? ((Date.now() - new Date(p.openedAt).getTime()) / 3_600_000).toFixed(1) : "?";
        ctx += `  ${p.id}: Pool=${p.pool?.slice(0,8)}... | SOL=${p.solDeployed} | hold=${holdH}h | lastPnL=${p.lastPnlPct !== undefined ? p.lastPnlPct+"%" : "N/A"}\n`;
      });
    }
  } catch(e) { ctx += `Open positions error: ${e.message}\n`; }

  // Trade stats + today's trades
  try {
    const d = getFullStats();
    const stats = d?.stats ?? {};
    const allTrades = d?.trades ?? [];
    const todayTrades = allTrades.filter(t => t.closedAt && new Date(t.closedAt) >= todayStart);

    ctx += `\n=== TRADE STATS ===\n`;
    ctx += `Total trades: ${stats.totalTrades ?? 0} | Win rate: ${stats.hitRate ?? 0}% | PnL: ${stats.totalPnlSol ?? 0} SOL\n`;
    ctx += `Avg win: ${stats.avgWinSol ?? 0} SOL | Avg loss: ${stats.avgLossSol ?? 0} SOL\n`;

    ctx += `\n=== TRADES TODAY (${todayTrades.length}) ===\n`;
    if (todayTrades.length === 0) {
      ctx += "Tidak ada trade yang ditutup hari ini.\n";
    } else {
      todayTrades.forEach(t => {
        ctx += `  ${t.id}: PnL=${t.pnlPercent?.toFixed(1)}% | ${t.closeReason ?? "closed"} | hold=${t.holdHours?.toFixed(1)}h\n`;
      });
    }

    const recent = allTrades.filter(t => t.closedAt).slice(-5);
    if (recent.length > 0) {
      ctx += `\n=== 5 LAST CLOSED TRADES ===\n`;
      recent.forEach(t => {
        ctx += `  ${t.id}: PnL=${t.pnlPercent?.toFixed(1)}% | reason=${t.closeReason ?? "closed"} | ${t.closedAt?.slice(0,10)}\n`;
      });
    }
  } catch(e) { ctx += `Trade stats error: ${e.message}\n`; }

  // Brain
  try {
    const brain = loadBrain();
    ctx += `\n=== AGENT BRAIN v${brain.version ?? "?"} ===\n`;
    ctx += `Last reflection: ${brain.latestReflection ?? "none"}\n`;
    if ((brain.selfWrittenRules ?? []).length > 0) ctx += `Rules: ${brain.selfWrittenRules.slice(0,3).join(" | ")}\n`;
    if ((brain.redFlags ?? []).length > 0) ctx += `Red flags: ${brain.redFlags.slice(0,3).join(" | ")}\n`;
  } catch(e) { ctx += `Brain error: ${e.message}\n`; }

  return ctx;
}

export async function chatWithGoyim(userId, userMessage, imageBase64 = null) {
  console.log("[CHAT] Incoming:", userMessage);
  const history = getHistory(userId);
  history.push({ role: "user", content: userMessage });

  const isReviewRequest = /daily.?review|\/review|rekap.?hari|review.?trade|laporan.?harian/i.test(userMessage);

  let tradingContext;
  let userPrompt = userMessage;
  if (isReviewRequest) {
    tradingContext = buildReviewContext();
    userPrompt = `${userMessage}\n\nBerikan daily review lengkap berdasarkan data di atas. Harus mencakup: (1) posisi aktif + PnL, (2) trade hari ini, (3) win/loss rate keseluruhan, (4) rekomendasi untuk besok, (5) vibe/lesson.`;
  } else {
    tradingContext = await buildTradingContext();
  }

  const data = await fetchWithRetry({
    model: config.openRouterModel,
    messages: [
      { role: "system", content: `${GOYIM_PERSONA}\n\n${tradingContext}` },
      ...history.slice(0, -1),
      { role: "user", content: userPrompt },
    ],
    temperature: 0.8,
    max_tokens: isReviewRequest ? 600 : 400,
  });

  const reply = data?.choices?.[0]?.message?.content ?? "Server lagi down bro, coba lagi bentar.";
  console.log("[CHAT] Reply:", reply.slice(0, 80));
  history.push({ role: "assistant", content: reply });
  saveHistory(userId, history);
  return reply;
}

export async function generateDailyReview() {
  const reviewContext = buildReviewContext();

  const prompt = `Tulis daily trading review berdasarkan data di atas.
Format:
📊 **DAILY REVIEW** — [tanggal hari ini]
💼 Posisi aktif: [list + PnL]
📈 Trade hari ini: [ringkasan]
🏆 Win rate: X% | Total PnL: X SOL
💡 Lesson: [1 insight penting]
🔮 Plan besok: [rekomendasi konkret]
🔥 Vibe: [1 kalimat jujur]

Gunakan bahasa Indonesia + trading slang. Max 250 kata.`;

  const data = await fetchWithRetry({
    model: config.openRouterModel,
    messages: [
      { role: "system", content: `${GOYIM_PERSONA}\n\n${reviewContext}` },
      { role: "user", content: prompt },
    ],
    temperature: 0.9,
    max_tokens: 500,
  });

  return data?.choices?.[0]?.message?.content ?? "Review gagal, server down.";
}


export async function chatWithGoyimVision(userId, caption, imageBase64) {
  console.log("[VISION] Processing image...");
  const tradingContext = await buildTradingContext();

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/goyim-agent",
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      messages: [
        { role: "system", content: `${GOYIM_PERSONA}\n\n${tradingContext}` },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            { type: "text", text: caption },
          ],
        },
      ],
      max_tokens: 500,
      temperature: 0.8,
    }),
  });

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content ?? "Gua gak bisa baca gambar ini bro.";
  console.log("[VISION] Reply:", reply.slice(0, 80));
  return reply;
}
