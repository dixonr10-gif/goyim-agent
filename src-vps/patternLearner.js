// src/patternLearner.js
// Analisa batch trade history → temukan pola yang konsisten profit/loss
// Dijalankan setiap N trade atau setiap hari
//
// ⚠️ AUTO-LEARNING DISABLED 2026-04-25
//
// The WRITE chain (savePatterns / learnPatterns / maybeLearnPatterns) is
// intentionally NOT called from anywhere in the codebase. The trigger at
// hunterAgent.js:362 has been commented out by Dixon to prevent auto-
// overwriting manual patterns.json tuning.
//
// The READ path (getPatternsForLLM) IS still used at hunterAgent.js:754 to
// inject the manually tuned patterns.json content into the LLM system prompt.
// KEEP THIS WORKING.
//
// patterns.json must only be edited MANUALLY + surgically + reviewed.
// NEVER restart auto-learning without Dixon's explicit approval.
//
// Memory directive (Goyim Agent project policy):
//   "postTradeAnalyzer + selfImprovingPrompt.js + agent_brain.json
//    INTENTIONALLY REMOVED (not broken). Reason: caused brain paralysis —
//    auto-evolved thresholds too aggressively, eventually impossible scores.
//    NEVER restart auto-learning pipeline."
//
//   patternLearner.js falls under same category — same risk, same rule.

import fetch from "node-fetch";
import fs from "fs";
import { config } from "../config.js";

const PATTERNS_FILE = "./data/patterns.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Jalankan pattern learning setiap berapa trade baru
const LEARN_EVERY_N_TRADES = 5;

// ─── Main ─────────────────────────────────────────────────────────────

/**
 * Cek apakah sudah waktunya pattern learning, lalu jalankan
 * @param {Array} allTrades - semua trade dari tradeMemory
 */
export async function maybeLearnPatterns(allTrades) {
  const closedTrades = allTrades.filter((t) => t.closedAt);
  const patterns = loadPatterns();

  const lastLearnedCount = patterns.learnedAtTradeCount ?? 0;
  const newTrades = closedTrades.length - lastLearnedCount;

  if (newTrades < LEARN_EVERY_N_TRADES) {
    console.log(
      `  📚 Pattern learning: ${newTrades}/${LEARN_EVERY_N_TRADES} new trades needed`
    );
    return patterns;
  }

  console.log(`\n🧬 Running pattern learning (${closedTrades.length} trades)...`);
  return await learnPatterns(closedTrades);
}

/**
 * Analisa seluruh trade history dan extract patterns
 */
async function learnPatterns(closedTrades) {
  if (closedTrades.length < 3) {
    console.log("  ⏳ Not enough trades for pattern learning (need 3+)");
    return loadPatterns();
  }

  const prompt = buildPatternPrompt(closedTrades);

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
          { role: "system", content: PATTERN_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Empty response from LLM");

    // Try direct parse first, then regex extraction
    let discovered;
    try {
      discovered = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        console.warn("  ⚠️ Patterns: no JSON in response, skipping update");
        return loadPatterns();
      }
      try {
        discovered = JSON.parse(match[0]);
      } catch (e2) {
        console.warn("  ⚠️ Patterns: JSON parse failed, skipping update:", e2.message);
        return loadPatterns();
      }
    }

    const patterns = {
      ...discovered,
      learnedAt: new Date().toISOString(),
      learnedAtTradeCount: closedTrades.length,
      tradesSampled: closedTrades.length,
    };

    savePatterns(patterns);

    console.log(`  ✅ Patterns updated:`);
    console.log(`     Best conditions: ${discovered.bestConditions?.slice(0, 2).join(", ")}`);
    console.log(`     Avoid: ${discovered.worstConditions?.slice(0, 2).join(", ")}`);

    return patterns;

  } catch (err) {
    console.error("  ❌ Pattern learning failed:", err.message);
    return loadPatterns();
  }
}

// ─── Prompts ──────────────────────────────────────────────────────────

const PATTERN_SYSTEM_PROMPT = `You are a quantitative analyst studying a DeFi liquidity agent's trade history.
Find statistically significant patterns that predict profitable vs losing trades.

IMPORTANT CONSTRAINTS:
- Do NOT suggest raising opportunityScore threshold above 60
- Do NOT suggest raising confidence threshold above 70
- Do NOT suggest rules that would block most trades — the agent needs to trade to learn
- Focus on ENTRY QUALITY improvements, not blanket rejections

Respond ONLY in this JSON format:
{
  "bestConditions": [
    "<condition that correlates with wins, e.g. 'fee APR > 40% at entry'>",
    "<condition2>",
    "<condition3>"
  ],
  "worstConditions": [
    "<condition that correlates with losses>",
    "<condition2>"
  ],
  "bestStrategy": {
    "name": "spot" | "bid-ask" | "curve",
    "whyItWorks": "<explanation>",
    "idealVolatility": "low" | "medium" | "high"
  },
  "optimalHoldHours": {
    "min": <number>,
    "max": <number>,
    "reasoning": "<why>"
  },
  "winningEntrySignals": ["<signal1>", "<signal2>"],
  "losingEntryMistakes": ["<mistake1>", "<mistake2>"],
  "poolCharacteristics": {
    "preferHighVolume": true | false,
    "preferHighFeeApr": true | false,
    "volumeThreshold": <number>,
    "feeAprThreshold": <number>
  },
  "confidenceCalibration": "<is the agent over/under-confident? what's the sweet spot?>",
  "topInsight": "<the single most important pattern discovered>",
  "suggestedRuleChanges": [
    "<concrete rule to add or change, e.g. 'increase stop loss to -5% for bid-ask strategy'>",
    "<rule2>"
  ]
}`;

function buildPatternPrompt(trades) {
  // Ringkas data buat hemat token
  const summary = trades.map((t) => ({
    strategy: t.strategy,
    outcome: t.outcome,
    pnl: parseFloat(t.pnlPercent).toFixed(1),
    holdH: t.holdDurationHours,
    confidence: t.llmConfidence,
    oppScore: t.opportunityScore,
    pool: t.poolName,
  }));

  const winRate = ((trades.filter((t) => t.outcome === "win").length / trades.length) * 100).toFixed(1);
  const avgPnl = (trades.reduce((a, t) => a + parseFloat(t.pnlPercent || 0), 0) / trades.length).toFixed(2);

  return `Analyze ${trades.length} DLMM trades:
Overall: ${winRate}% win rate | avg P&L: ${avgPnl}%

Trade data:
${JSON.stringify(summary, null, 2)}

Find patterns that separate winners from losers. Be specific and data-driven.`;
}

// ─── Persistence ──────────────────────────────────────────────────────

function savePatterns(patterns) {
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(PATTERNS_FILE, JSON.stringify(patterns, null, 2));
}

export function loadPatterns() {
  try {
    if (!fs.existsSync(PATTERNS_FILE)) return {};
    return JSON.parse(fs.readFileSync(PATTERNS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Format patterns buat dikirim ke LLM sebagai context
 */
export function getPatternsForLLM() {
  const p = loadPatterns();
  if (!p.topInsight) return "No patterns discovered yet.";

  const lines = [
    `=== DISCOVERED PATTERNS (from ${p.tradesSampled} trades) ===`,
    `Top insight: ${p.topInsight}`,
    ``,
    `Best entry conditions:`,
    ...(p.bestConditions ?? []).map((c) => `  ✅ ${c}`),
    ``,
    `Avoid these conditions:`,
    ...(p.worstConditions ?? []).map((c) => `  ❌ ${c}`),
    ``,
    `Best strategy: ${p.bestStrategy?.name ?? "unknown"} — ${p.bestStrategy?.whyItWorks ?? ""}`,
    `Optimal hold: ${p.optimalHoldHours?.min ?? "?"}–${p.optimalHoldHours?.max ?? "?"}h`,
    ``,
    `Confidence calibration: ${p.confidenceCalibration ?? "N/A"}`,
    ``,
    `Suggested rule changes:`,
    ...(p.suggestedRuleChanges ?? []).map((r) => `  → ${r}`),
  ];

  return lines.join("\n");
}
