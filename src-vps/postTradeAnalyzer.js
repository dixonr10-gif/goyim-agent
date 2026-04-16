// src/postTradeAnalyzer.js
// Setelah setiap posisi ditutup, LLM bedah kenapa menang/kalah
// Hasilnya disimpan sebagai "lesson" yang dibaca di loop berikutnya

import fetch from "node-fetch";
import fs from "fs";
import { config } from "../config.js";

const LESSONS_FILE = "./data/lessons.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ENABLED = process.env.ENABLE_POST_TRADE_ANALYSIS !== "false";
const MAX_RETRIES = 1;

// Track already-analyzed trades to prevent spam
const analyzedTrades = new Set();

// ─── Main ─────────────────────────────────────────────────────────────

export async function analyzeClosedTrade(trade, marketConditions = {}) {
  if (!ENABLED) return null;
  if (!trade?.id) return null;
  if (analyzedTrades.has(trade.id)) return null;
  analyzedTrades.add(trade.id);

  const model = config.openRouterModelFast;
  const pnl = parseFloat(trade.pnlPercent ?? 0).toFixed(1);
  const outcome = (trade.outcome ?? "?").toUpperCase();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const prompt = attempt === 0
        ? `Trade: ${trade.poolName ?? "?"} ${outcome} ${pnl}% held ${trade.holdDurationHours ?? "?"}h. Reply ONLY with JSON: {"summary":"one sentence","lesson":"one actionable tip","avoid":"pattern to avoid or null","seek":"pattern to seek or null"}`
        : `You MUST reply with ONLY a JSON object, no markdown, no explanation.\nTrade: ${trade.poolName ?? "?"} ${outcome} ${pnl}% held ${trade.holdDurationHours ?? "?"}h.\nRequired format: {"summary":"string","lesson":"string","avoid":"string or null","seek":"string or null"}`;

      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/goyim-agent",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 200,
        }),
      });

      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content;
      if (!raw) { continue; }

      // Try direct parse, then regex extract
      let analysis;
      try { analysis = JSON.parse(raw); } catch {}
      if (!analysis) {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { analysis = JSON.parse(m[0]); } catch {} }
      }
      if (!analysis) {
        if (attempt < MAX_RETRIES) {
          console.log(`  [PostTrade] attempt ${attempt + 1} JSON parse failed — retrying`);
          continue;
        }
        console.log(`  [PostTrade] JSON parse failed after retry — skipped`);
        return null;
      }

      const lesson = {
        tradeId: trade.id,
        pool: trade.pool,
        poolName: trade.poolName,
        strategy: trade.strategy,
        outcome: trade.outcome,
        pnlPercent: trade.pnlPercent,
        holdDurationHours: trade.holdDurationHours,
        analyzedAt: new Date().toISOString(),
        ...analysis,
      };

      saveLessson(lesson);
      console.log(`  [PostTrade] lesson: ${analysis.summary ?? analysis.oneLiner ?? "saved"}`);
      return lesson;
    } catch {
      if (attempt < MAX_RETRIES) continue;
      // Silent fail after all retries — no Telegram, no error emoji
      console.log(`  [PostTrade] analysis failed for ${trade.id} — skipped`);
      return null;
    }
  }
  return null;
}

// ─── Persistence ──────────────────────────────────────────────────────

function saveLessson(lesson) {
  const lessons = loadLessons();
  lessons.push(lesson);
  const trimmed = lessons.slice(-100);
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(trimmed, null, 2));
}

export function loadLessons() {
  try {
    if (!fs.existsSync(LESSONS_FILE)) return [];
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

// ─── Post-trade review: one-line Haiku review appended to lessons.json ────
// Separate from analyzeClosedTrade — produces a compact single-line summary
// for log tailing + quick human review, not a structured JSON lesson.
const reviewedTrades = new Set();

export async function reviewClosedTrade(trade) {
  if (!ENABLED || !trade?.id) return null;
  if (reviewedTrades.has(trade.id)) return null;

  const existing = loadLessons();
  if (existing.some(l => l.tradeId === trade.id && l.type === "review")) {
    reviewedTrades.add(trade.id);
    return null;
  }
  reviewedTrades.add(trade.id);

  const poolName = trade.poolName ?? "?";
  const symbol = poolName.split(/[-\/]/)[0] || "?";
  const pnl = typeof trade.pnlPercent === "number" ? trade.pnlPercent.toFixed(1) : "?";
  const exitReason = trade.exitReason ?? trade.closeReason ?? "UNKNOWN";
  const holdH = trade.holdDurationHours ?? trade.holdHours ?? "?";

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/goyim-agent",
      },
      body: JSON.stringify({
        model: config.openRouterModelFast,
        max_tokens: 80,
        temperature: 0.3,
        messages: [
          { role: "system", content: "You review closed DLMM LP trades. Reply with ONE sentence (max 15 words) describing the key takeaway. No markdown, no preamble." },
          { role: "user", content: `Trade closed: pool=${poolName} exit=${exitReason} pnl=${pnl}% hold=${holdH}h. Key takeaway?` },
        ],
      }),
    });
    clearTimeout(timeoutId);

    const data = await res.json();
    const raw = (data?.choices?.[0]?.message?.content ?? "").trim();
    if (!raw) return null;

    const line = `[${exitReason} ${pnl}%] ${symbol}: ${raw}`;
    const lessons = loadLessons();
    lessons.push({
      type: "review",
      tradeId: trade.id,
      pool: trade.pool,
      poolName,
      exitReason,
      pnlPercent: trade.pnlPercent,
      holdDurationHours: trade.holdDurationHours,
      reviewedAt: new Date().toISOString(),
      line,
      review: raw,
    });
    const trimmed = lessons.slice(-100);
    fs.mkdirSync("./data", { recursive: true });
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(trimmed, null, 2));
    console.log(line);
    return line;
  } catch (e) {
    console.log(`  [PostTradeReview] ${symbol} skip (${e.message?.slice(0, 60) || "error"})`);
    return null;
  }
}

export function getRecentLessonsForLLM(limit = 10) {
  const lessons = loadLessons().slice(-limit);
  if (lessons.length === 0) return "No lessons learned yet.";

  return lessons
    .map((l, i) =>
      `[Lesson ${i + 1}] ${l.outcome?.toUpperCase() ?? "?"} | ${l.poolName ?? "?"}\n` +
      `  → ${l.lesson ?? l.summary ?? "N/A"}\n` +
      `  Avoid: ${l.avoidPattern ?? l.avoid ?? "N/A"} | Seek: ${l.seekPattern ?? l.seek ?? "N/A"}`
    )
    .join("\n\n");
}
