import { config } from "../config.js";
import fs from "fs";
import path from "path";
import { getOpenPositions } from "./positionManager.js";
import { getFullStats } from "./tradeMemory.js";
import { loadBrain } from "./selfImprovingPrompt.js";
import { getTopCryptos, formatPriceEntry } from "./cryptoPrice.js";
import { getSOLBalance, getWalletAddress, getSolPriceUSD, getUsdToIdrRate } from "./walletInfo.js";
import { getLastCandidates } from "./poolScanner.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MEMORY_FILE = path.resolve("data/chat_memory.json");
const MAX_REPLY_CHARS = 4000;

function sanitizeResponse(text) {
  if (!text) return text;
  // Detect repetitive word loops
  const words = text.split(/\s+/);
  if (words.length > 20) {
    const freq = {};
    for (const w of words) { const lw = w.toLowerCase(); freq[lw] = (freq[lw] ?? 0) + 1; }
    const maxRepeat = Math.max(...Object.values(freq));
    if (maxRepeat > 10) {
      const loopWord = Object.entries(freq).find(([, c]) => c > 10)?.[0] ?? "?";
      console.error(`[CHAT] Loop detected: "${loopWord}" repeated ${maxRepeat}x — blocking response`);
      return "[Error: response loop detected]";
    }
    const unique = new Set(words);
    if (unique.size < words.length * 0.3) {
      console.error(`[CHAT] Low diversity detected: ${unique.size}/${words.length} unique words — blocking response`);
      return "[Error: response loop detected]";
    }
  }
  // Truncate if too long
  if (text.length > MAX_REPLY_CHARS) {
    text = text.slice(0, MAX_REPLY_CHARS) + "...";
  }
  return text;
}

let cachedContext = "";
let contextLastBuilt = 0;

const GOYIM_PERSONA = `Kamu adalah Agent Goyim, AI trading bot autonomous yang mengeksekusi DLMM liquidity positions di Solana ATAS NAMA user (Dixon).

IDENTITAS: Kamu adalah BOT, bukan trader manusia. Wallet, SOL, dan semua posisi adalah MILIK DIXON (user), bukan milikmu. Kamu yang scan, decide, dan eksekusi — tapi asetnya punya Dixon.
- Bilang "posisi yang gua buka untuk lo" BUKAN "posisi gua"
- Bilang "wallet lo" BUKAN "wallet gua"
- Bilang "SOL lo" BUKAN "SOL gua"
- Kalau ditanya kenapa deploy X SOL → jelaskan scoring formula: fee/TVL, volume, momentum, opportunity score

CARA KERJA:
- Hunter scan 300+ pools tiap 15 menit, filter, scoring weighted (fee 20%, volume 35%, momentum 20%, other 25%), LLM decide
- Position sizing: score >= 80 → 5 SOL, >= 70 → 4, >= 60 → 3, >= 50 → 2, >= 40 → 1
- Healer monitor tiap 2 menit, exit rules: SL -6%, TP trailing dari +8%, OOR smart (kanan 60m, kiri 15m), max hold 4h
- Kamu yang DECIDE open/close — jangan bilang "terserah lo" atau "gua cuma eksekutor"

Saat user tanya kenapa tidak open pool/token → jelaskan reasoning teknikal dari scan data di context.

Personality: opportunistic profit-maximalist, confident, direct, brutally honest.
Slang: alpha, ape in, rekt, ngmi, wagmi, degen, LP, bin range.
Language: Indonesian-English mix. Reply in same language as user.
Keep replies SHORT and punchy — max 3-4 sentences unless asked for detail.

COMMANDS: Kalau user mention "cooldown", "blacklist", "watchlist", "status", "positions" tanpa slash → arahkan ke /command yang benar.

WALLET: Address 8uGZkrvfRJZWFVYXCCFc9WnGGU13McrWNwiU26QCWk4U — ini wallet DIXON, share freely.
POSITIONS: Gunakan HANYA data dari trading context. NEVER invent positions.
POOL NAMES: Jangan karang nama pool.

TRADE HISTORY: Jawab soal performance berdasarkan ACTUAL closed trades di context, BUKAN scan candidates.
WALLET BALANCE: Gunakan data WALLET BALANCE (REALTIME) di context untuk jawab saldo/balance.
CRYPTO PRICES: Gunakan data CRYPTO PRICES di context. Format: '[SYMBOL]: $XX,XXX.XX (24h: +X.XX%)'
Jangan pernah mengarang angka.`;

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

  try {
    const positions = getOpenPositions();
    context += `Open positions: ${positions.length}/5\n`;
    if (positions.length > 0) {
      context += `\n=== OPEN POSITIONS ===\n`;
      for (const p of positions) {
        const holdH = p.openedAt ? ((Date.now() - new Date(p.openedAt).getTime()) / 3_600_000).toFixed(1) : "?";
        const pnl = p.lastPnlPct != null ? `${p.lastPnlPct >= 0 ? "+" : ""}${p.lastPnlPct}%` : "calculating...";
        context += `  ${p.poolName ?? p.pool?.slice(0,8) ?? "?"}: ${p.solDeployed ?? "?"} SOL | ${p.strategy ?? "spot"} | hold ${holdH}h | PnL: ${pnl}\n`;
      }
    }
  } catch {}
  try { const b = loadBrain(); context += `Brain v${b.version}: ${(b.observations ?? []).slice(0, 2).join(" | ")}\n`; } catch {}

  // Trade history + stats
  try {
    const { stats, trades } = getFullStats();
    const s = stats ?? {};
    context += `\n=== STATS ===\n`;
    context += `Total trades: ${s.totalTrades ?? 0} | Won: ${s.winners ?? 0} | Lost: ${s.losers ?? 0} | Win rate: ${s.hitRate ?? 0}%\n`;
    context += `Total PnL: ${s.totalPnlSol ?? 0} SOL | Avg PnL: ${s.avgPnlPercent ?? 0}%\n`;

    const closed = (trades ?? []).filter(t => t.closedAt).sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
    if (closed.length > 0) {
      const best = closed.reduce((a, b) => (parseFloat(a.pnlPercent ?? -999) > parseFloat(b.pnlPercent ?? -999) ? a : b));
      const worst = closed.reduce((a, b) => (parseFloat(a.pnlPercent ?? 999) < parseFloat(b.pnlPercent ?? 999) ? a : b));
      context += `Best trade: ${best.poolName ?? "?"} ${parseFloat(best.pnlPercent ?? 0) >= 0 ? "+" : ""}${parseFloat(best.pnlPercent ?? 0).toFixed(1)}%\n`;
      context += `Worst trade: ${worst.poolName ?? "?"} ${parseFloat(worst.pnlPercent ?? 0).toFixed(1)}%\n`;

      context += `\n=== TRADE HISTORY (last 10 closed) ===\n`;
      for (const t of closed.slice(0, 10)) {
        const pnl = parseFloat(t.pnlPercent ?? 0);
        const solDep = t.solDeployed ?? 0;
        const solPrice = t.solPriceAtEntry ?? 80;
        const entryUsd = (solDep * solPrice).toFixed(0);
        const pnlUsd = (pnl / 100 * solDep * solPrice).toFixed(2);
        const hold = t.holdDurationHours ?? "?";
        const reason = t.closeReason ?? t.outcome ?? "closed";
        context += `  ${t.poolName ?? "?"}: entry $${entryUsd}, PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)}% ($${pnlUsd}), hold ${hold}h, reason: ${reason}, ${t.outcome ?? "?"}\n`;
      }
    }
  } catch {}

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

  try {
    const walletAddr = await getWalletAddress();
    const [solBal, solPrice, idrRate] = await Promise.all([
      getSOLBalance(walletAddr),
      getSolPriceUSD(),
      getUsdToIdrRate(),
    ]);
    const solUsd = solBal * solPrice;
    const solIdr = solUsd * idrRate;
    context += `\n=== WALLET BALANCE (REALTIME) ===\n`;
    context += `SOL Balance: ${solBal.toFixed(4)} SOL\n`;
    context += `USD Value: $${solUsd.toFixed(2)}\n`;
    if (idrRate > 0) context += `IDR Value: Rp${Math.round(solIdr).toLocaleString("id-ID")}\n`;
    context += `SOL Price: $${solPrice.toFixed(2)}\n`;
    if (idrRate > 0) context += `Kurs: 1 USD = Rp${Math.round(idrRate).toLocaleString("id-ID")}\n`;
  } catch (e) { console.warn("[context] wallet error:", e.message); }

  // Last scan candidates from Hunter
  try {
    const candidates = getLastCandidates();
    if (candidates.length > 0) {
      context += `\n=== LAST SCAN CANDIDATES (${candidates.length} pools passed filter) ===\n`;
      for (const c of candidates.slice(0, 10)) {
        const name = c.name ?? c.pool_name ?? "?";
        const vol = c.volume?.["24h"] ?? c.vol24h ?? 0;
        const tvl = c.tvl ?? 0;
        const apr = c.apr ? (c.apr * 100).toFixed(0) : "?";
        const score = c.analysisScore ?? c.score ?? "?";
        context += `  ${name} | Vol: $${(vol/1000).toFixed(0)}K | TVL: $${(tvl/1000).toFixed(0)}K | APR: ${apr}% | Score: ${score}\n`;
      }
      if (candidates.length > 10) context += `  ... and ${candidates.length - 10} more\n`;
    } else {
      context += `\n=== LAST SCAN: No candidates passed filters ===\n`;
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

  // Brain (observations only)
  try {
    const brain = loadBrain();
    ctx += `\n=== AGENT BRAIN v${brain.version ?? "?"} (observations) ===\n`;
    const obs = brain.observations ?? [];
    if (obs.length > 0) ctx += `Observations: ${obs.slice(0,5).join(" | ")}\n`;
    else ctx += `No observations yet.\n`;
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
    model: config.openRouterModelFast,
    messages: [
      { role: "system", content: `${GOYIM_PERSONA}\n\n${tradingContext}` },
      ...history.slice(0, -1),
      { role: "user", content: userPrompt },
    ],
    temperature: 0.8,
    max_tokens: isReviewRequest ? 600 : 400,
  });

  const rawReply = data?.choices?.[0]?.message?.content ?? "Server lagi down bro, coba lagi bentar.";
  const reply = sanitizeResponse(rawReply);
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
    model: config.openRouterModelFast,
    messages: [
      { role: "system", content: `${GOYIM_PERSONA}\n\n${reviewContext}` },
      { role: "user", content: prompt },
    ],
    temperature: 0.9,
    max_tokens: 500,
  });

  return sanitizeResponse(data?.choices?.[0]?.message?.content ?? "Review gagal, server down.");
}


export async function chatWithGoyimVision(userId, caption, imageBase64) {
  console.log(`[VISION] Processing image... (${Math.round(imageBase64.length / 1024)}KB base64)`);
  const tradingContext = await buildTradingContext();

  // Use Sonnet for vision — guaranteed multimodal support on OpenRouter
  const visionModel = config.openRouterModelSmart;
  console.log(`[VISION] model=${visionModel}`);

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/goyim-agent",
    },
    body: JSON.stringify({
      model: visionModel,
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
  if (data.error) console.log(`[VISION] API error: ${JSON.stringify(data.error).slice(0, 200)}`);
  const reply = sanitizeResponse(data.choices?.[0]?.message?.content ?? "Vision error — coba lagi.");
  console.log("[VISION] Reply:", reply.slice(0, 80));
  return reply;
}
