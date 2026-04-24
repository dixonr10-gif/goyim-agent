import { config } from "../config.js";
import fs from "fs";
import path from "path";
import { getOpenPositions } from "./positionManager.js";
import { getFullStats } from "./tradeMemory.js";
import { getTopCryptos, formatPriceEntry } from "./cryptoPrice.js";
import { getSOLBalance, getWalletAddress, getSolPriceUSD, getUsdToIdrRate } from "./walletInfo.js";
import { getLastCandidates } from "./poolScanner.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MEMORY_FILE = path.resolve("data/chat_memory.json");
const MAX_REPLY_CHARS = 4000;

// NOTE: this function is ONLY ever called on LLM-generated output (assistant
// messages), never on user input. It catches degenerate LLM responses (real
// token loops) without false-flagging legitimate technical answers that
// repeat trading terms like "TP", "SL", "Hunter" many times.
function sanitizeResponse(text) {
  if (!text) return text;
  const words = text.split(/\s+/);

  // Check 1: same word repeated 6+ times CONSECUTIVELY → real loop
  // (e.g. "the the the the the the the" — what broken LLM output looks like)
  // Skip single-char tokens like "-", "*", "•", "—" which are bullet/dash markers
  // in markdown lists and don't represent loops.
  let runWord = null, runLen = 0, maxRun = 0, loopWord = null;
  for (const w of words) {
    if (w.length < 2) continue;
    const lw = w.toLowerCase();
    if (lw === runWord) {
      runLen++;
      if (runLen > maxRun) { maxRun = runLen; loopWord = lw; }
    } else {
      runWord = lw;
      runLen = 1;
    }
  }
  if (maxRun >= 6) {
    console.error(`[CHAT] Loop detected: word "${loopWord}" repeated ${maxRun}x consecutively — blocking response`);
    return "[Error: response loop detected]";
  }

  // Check 2: extremely low vocabulary diversity on long replies → degenerate output
  // (was 30% which false-flagged technical answers; lowered to 10% on 50+ words)
  if (words.length > 50) {
    const unique = new Set(words.map(w => w.toLowerCase()));
    if (unique.size < words.length * 0.10) {
      console.error(`[CHAT] Low diversity: ${unique.size}/${words.length} unique words — blocking response`);
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

---TECHNICAL KNOWLEDGE---
Architecture:
- Hunter Agent: scan pools every 30 min, select best pool via LLM scoring
- Healer Agent: monitor positions every 2 min, handle SL/TP/OOR
- Scoring: fee/TVL 20%, volume 35%, momentum 20%, opportunity 25%

Key Features:
- Trailing TP: activates at +6%, trail -3%
- Stop Loss: -6%
- Dynamic bins: 50/70/90/110 based on 1h volatility
- Spot strategy: 10% upside buffer
- BidAsk strategy: 40% below, 60% above active bin
- RSI filter: skip if RSI > 80 or < 30
- Strict hours 14-18 WIB: tighter SL/TP/volume
- Pool Memory: track per-pool win rate, bonus/penalty
- Blacklist: auto after 5 losses, decay 7 days
- EVOLVE: auto-adjust MIN_POOL_FEE_APR & MIN_POOL_VOLUME
- LPAgent: PnL data source (accurate, fees included)

Common Issues & Solutions:
- Hunter STALE → strict hours cooldown aktif (normal)
- Bot tidak open posisi → cek blacklist/brain paralysis
- PnL N/A → tunggu healer cycle 2 menit
- Swap failed → RPC 429, retry otomatis
- OOR langsung → grace period 35m (kanan) 15m (kiri)

VPS Info:
- IP: 152.42.167.126
- Deploy: node scripts/deploy.cjs
- Logs: pm2 logs goyim-agent --lines 50
- Restart: pm2 restart goyim-agent
---END TECHNICAL KNOWLEDGE---

BAHASA & GAYA KOMUNIKASI:
- Jawab SELALU dalam bahasa Indonesia casual
- Campur istilah trading/crypto dalam English (LP, bin range, SL, TP, OOR, fee APR, dll)
- Panggil user "bro"
- Gaya seperti teman trader yang paham teknikal
- Santai tapi informatif, tidak formal
- Kalau ada error → jelasin root cause dulu, baru kasih solusi
- Kalau tidak tau → "gua kurang tau bro, tanya Claude.ai untuk analisis lebih dalam"

CARA JAWAB:
- Mulai dengan diagnosis singkat
- Jelasin root cause
- Kasih solusi step by step
- Pakai emoji relevan
- Maksimal 5-6 kalimat, tidak bertele-tele

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

export async function chatWithGoyim(userId, userMessage, imageBase64 = null) {
  console.log("[CHAT] Incoming:", userMessage);
  const history = getHistory(userId);
  history.push({ role: "user", content: userMessage });

  const tradingContext = await buildTradingContext();

  const data = await fetchWithRetry({
    model: config.openRouterModelFast,
    messages: [
      { role: "system", content: `${GOYIM_PERSONA}\n\n${tradingContext}` },
      ...history.slice(0, -1),
      { role: "user", content: userMessage },
    ],
    temperature: 0.8,
    max_tokens: 400,
  });

  const rawReply = data?.choices?.[0]?.message?.content ?? "Server lagi down bro, coba lagi bentar.";
  const reply = sanitizeResponse(rawReply);
  console.log("[CHAT] Reply:", reply.slice(0, 80));
  history.push({ role: "assistant", content: reply });
  saveHistory(userId, history);
  return reply;
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
