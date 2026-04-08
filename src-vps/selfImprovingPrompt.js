// src/selfImprovingPrompt.js
// Observation-only brain — records patterns from past trades as soft context.
// NEVER writes hard rules, thresholds, or constraints. LLM stays free to decide.

import fetch from "node-fetch";
import fs from "fs";
import { config } from "../config.js";
import { loadLessons } from "./postTradeAnalyzer.js";

const BRAIN_FILE = "./data/agent_brain.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const UPDATE_EVERY_HOURS = 6;

// Words that indicate a hard rule — strip any observation containing these
const BANNED_WORDS = /\b(require|must|only|reject|block|minimum|threshold|never|always|mandatory|forbidden)\b/i;
const BANNED_OPERATORS = /[><=≥≤]{1,2}\s*\d/;

function emptyBrain() {
  return {
    version: 0,
    lastUpdated: null,
    observations: [],
    stats: { totalTrades: 0, winRate: 0, avgPnl: 0 },
  };
}

function sanitizeObservation(obs) {
  if (typeof obs !== "string") return null;
  if (BANNED_WORDS.test(obs)) return null;
  if (BANNED_OPERATORS.test(obs)) return null;
  // Max 200 chars per observation
  return obs.slice(0, 200).trim() || null;
}

// ─── Main ─────────────────────────────────────────────────────────────

export async function maybeUpdateBrain(stats) {
  const brain = loadBrain();
  const lastUpdated = brain.lastUpdated ? new Date(brain.lastUpdated) : null;
  const hoursSinceUpdate = lastUpdated
    ? (Date.now() - lastUpdated.getTime()) / 3_600_000
    : Infinity;

  if (hoursSinceUpdate < UPDATE_EVERY_HOURS) {
    const nextUpdate = UPDATE_EVERY_HOURS - hoursSinceUpdate;
    console.log(`  🧠 Brain v${brain.version} (observations) | Next update in ${nextUpdate.toFixed(1)}h`);
    return brain;
  }

  if ((stats?.totalTrades ?? 0) < 5) {
    console.log("  🧠 Brain: not enough trades yet for observations");
    return brain;
  }

  console.log(`\n🧠 Updating brain observations (v${brain.version} → v${brain.version + 1})...`);
  return await updateBrain(stats, brain);
}

async function updateBrain(stats, currentBrain) {
  const lessons = loadLessons().slice(-15);
  if (lessons.length === 0) return currentBrain;

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/goyim-agent",
      },
      body: JSON.stringify({
        model: config.openRouterModelFast,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(stats, lessons) },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
      }),
    });

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Empty LLM response");

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) { console.warn("  ⚠️ Brain: no JSON, keeping current"); return currentBrain; }
      parsed = JSON.parse(match[0]);
    }

    // Sanitize: strip anything that looks like a hard rule
    const rawObs = parsed.observations ?? [];
    const clean = rawObs.map(sanitizeObservation).filter(Boolean).slice(0, 10);
    const stripped = rawObs.length - clean.length;
    if (stripped > 0) console.log(`  ⚠️ Brain: stripped ${stripped} hard-rule observation(s)`);

    const newBrain = {
      version: currentBrain.version + 1,
      lastUpdated: new Date().toISOString(),
      observations: clean,
      stats: {
        totalTrades: stats.totalTrades ?? 0,
        winRate: stats.hitRate ?? 0,
        avgPnl: stats.avgPnlPercent ?? 0,
      },
    };

    saveBrain(newBrain);
    console.log(`  ✅ Brain v${newBrain.version}: ${clean.length} observations saved`);
    clean.slice(0, 3).forEach(o => console.log(`    📝 ${o}`));
    return newBrain;

  } catch (err) {
    console.error("  ❌ Brain update failed:", err.message);
    return currentBrain;
  }
}

// ─── Prompts ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a DeFi trading observer. Your job is to note PATTERNS from past trades.

OUTPUT FORMAT — respond ONLY with this JSON:
{
  "observations": [
    "Pools with high volume spikes in 5m but low 1h volume tended to be wash-traded",
    "Tokens younger than 2 hours had higher IL in recent trades",
    "Spot strategy performed better than bidask in sideways markets"
  ]
}

RULES FOR OBSERVATIONS:
- Write observations as factual patterns, NOT rules or commands
- Use past tense or "tended to" / "often" / "sometimes"
- NEVER use words like: require, must, only, reject, block, minimum, threshold, never, always
- NEVER write numerical thresholds with operators (>=, <=, >, <)
- WRONG: "You should require APR > 40%"
- RIGHT: "Pools with APR above 40% tended to generate more fees in recent trades"
- WRONG: "Never open when organic score < 50"
- RIGHT: "Low organic score pools often went out of range quickly"
- Maximum 10 observations, each under 200 characters
- Focus on what HAPPENED, not what to DO`;

function buildPrompt(stats, lessons) {
  return `Recent trading performance:
- Total trades: ${stats.totalTrades}
- Win rate: ${stats.hitRate}%
- Avg P&L: ${stats.avgPnlPercent}%

Recent trade lessons (last 15):
${lessons.map(l => `[${l.outcome}] ${l.strategy} | ${l.lesson}`).join("\n") || "No lessons yet"}

Based on these results, write 5-10 factual observations about patterns you notice.
Remember: observations only, no rules or thresholds.`;
}

// ─── Persistence ──────────────────────────────────────────────────────

function saveBrain(brain) {
  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
}

export function loadBrain() {
  try {
    if (!fs.existsSync(BRAIN_FILE)) return emptyBrain();
    return JSON.parse(fs.readFileSync(BRAIN_FILE, "utf-8"));
  } catch {
    return emptyBrain();
  }
}

/**
 * Inject observations as soft context — NOT rules
 */
export function getBrainContextForLLM() {
  const brain = loadBrain();
  const obs = brain.observations ?? [];
  if (obs.length === 0) return "";

  return [
    "=== OBSERVATIONS FROM PAST TRADES (for context, not rules) ===",
    ...obs.map(o => `- ${o}`),
    "",
    "NOTE: These are observations, not constraints. You are free to trade as you see fit.",
  ].join("\n");
}
