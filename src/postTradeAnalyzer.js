// src/postTradeAnalyzer.js
// Setelah setiap posisi ditutup, LLM bedah kenapa menang/kalah
// Hasilnya disimpan sebagai "lesson" yang dibaca di loop berikutnya

import fetch from "node-fetch";
import fs from "fs";
import { config } from "../config.js";

const LESSONS_FILE = "./data/lessons.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ─── Main ─────────────────────────────────────────────────────────────

/**
 * Analisa mendalam setelah trade ditutup
 * @param {Object} trade - trade record dari tradeMemory
 * @param {Object} marketConditions - kondisi market saat open & close
 */
export async function analyzeClosedTrade(trade, marketConditions = {}) {
  console.log(`\n🔬 Post-trade analysis: ${trade.id}`);

  const prompt = buildAnalysisPrompt(trade, marketConditions);

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/goyim-agent",
      },
      body: JSON.stringify({
        model: config.openRouterModel,
        messages: [
          { role: "system", content: POST_TRADE_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Empty response");

    const analysis = JSON.parse(raw);

    // Simpan lesson ke file
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

    console.log(`  ✅ Lesson saved: ${analysis.oneLiner}`);
    return lesson;

  } catch (err) {
    console.error("  ❌ Post-trade analysis failed:", err.message);
    return null;
  }
}

// ─── Prompt ───────────────────────────────────────────────────────────

const POST_TRADE_SYSTEM_PROMPT = `You are a DeFi trading coach analyzing a completed DLMM liquidity position.
Your job: extract actionable lessons from each trade result.

Respond ONLY in this JSON format:
{
  "oneLiner": "<one sentence summary of what happened>",
  "whatWentRight": ["<point1>", "<point2>"],
  "whatWentWrong": ["<point1>", "<point2>"],
  "rootCause": "<main reason for win/loss>",
  "lesson": "<specific actionable lesson for future trades>",
  "avoidPattern": "<pattern/condition to avoid in future, or null>",
  "seekPattern": "<pattern/condition to seek in future, or null>",
  "strategyVerdict": "good_fit" | "bad_fit" | "neutral",
  "poolVerdict": "good_pool" | "bad_pool" | "neutral",
  "confidenceWasAccurate": true | false,
  "suggestedAdjustment": "<one concrete change to make next time>"
}`;

function buildAnalysisPrompt(trade, marketConditions) {
  return `Analyze this completed DLMM trade:

=== TRADE DETAILS ===
Pool: ${trade.poolName} (${trade.pool})
Strategy: ${trade.strategy}
Opened: ${trade.openedAt}
Closed: ${trade.closedAt}
Hold duration: ${trade.holdDurationHours} hours
SOL deployed: ${trade.solDeployed}
SOL returned: ${trade.solReturned}
P&L: ${trade.pnlPercent >= 0 ? "+" : ""}${parseFloat(trade.pnlPercent).toFixed(2)}%
Outcome: ${trade.outcome.toUpperCase()}

=== LLM DECISION AT ENTRY ===
Confidence: ${trade.llmConfidence}%
Rationale: ${trade.llmRationale}
Opportunity score: ${trade.opportunityScore ?? "N/A"}

=== MARKET CONDITIONS ===
${JSON.stringify(marketConditions, null, 2)}

What went right or wrong? What should the agent do differently next time?`;
}

// ─── Persistence ──────────────────────────────────────────────────────

function saveLessson(lesson) {
  const lessons = loadLessons();
  lessons.push(lesson);
  // Keep max 100 lessons (FIFO)
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

/**
 * Format lessons buat dikirim ke LLM (ringkas)
 */
export function getRecentLessonsForLLM(limit = 10) {
  const lessons = loadLessons().slice(-limit);
  if (lessons.length === 0) return "No lessons learned yet.";

  return lessons
    .map((l, i) =>
      `[Lesson ${i + 1}] ${l.outcome.toUpperCase()} | ${l.strategy} | ${l.poolName}\n` +
      `  → ${l.lesson}\n` +
      `  Avoid: ${l.avoidPattern ?? "N/A"}\n` +
      `  Seek: ${l.seekPattern ?? "N/A"}`
    )
    .join("\n\n");
}
