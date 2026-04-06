// src/selfImprovingPrompt.js
// Agent menulis "brain notes" sendiri setelah setiap sesi
// Notes ini dibaca ulang di setiap loop → agent makin tajam seiring waktu

import fetch from "node-fetch";
import fs from "fs";
import { config } from "../config.js";
import { loadPatterns } from "./patternLearner.js";
import { loadLessons } from "./postTradeAnalyzer.js";

const BRAIN_FILE = "./data/agent_brain.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Update brain setiap berapa jam
const UPDATE_EVERY_HOURS = 6;

// ─── Brain structure ──────────────────────────────────────────────────

function emptyBrain() {
  return {
    version: 0,
    lastUpdated: null,
    
    // Self-written rules oleh agent
    selfWrittenRules: [],
    
    // Belief system: agent's current "view" of the market
    marketBeliefs: [],
    
    // Strategy preferences berdasarkan experience
    strategyPreferences: {},
    
    // Red flags — kondisi yang harus trigger skip
    redFlags: [],
    
    // Green flags — kondisi yang harus trigger open
    greenFlags: [],
    
    // Refleksi terbaru
    latestReflection: "",
    
    // Confidence adjustment
    confidenceBias: 0,  // -20 sampai +20, disesuaikan dari akurasi historis
  };
}

// ─── Main ─────────────────────────────────────────────────────────────

/**
 * Update brain kalau sudah waktunya
 */
export async function maybeUpdateBrain(stats) {
  const brain = loadBrain();
  const lastUpdated = brain.lastUpdated ? new Date(brain.lastUpdated) : null;
  const hoursSinceUpdate = lastUpdated
    ? (Date.now() - lastUpdated.getTime()) / 3_600_000
    : Infinity;

  if (hoursSinceUpdate < UPDATE_EVERY_HOURS) {
    const nextUpdate = UPDATE_EVERY_HOURS - hoursSinceUpdate;
    console.log(`  🧠 Brain v${brain.version} | Next update in ${nextUpdate.toFixed(1)}h`);
    return brain;
  }

  console.log(`\n🧠 Updating agent brain (v${brain.version} → v${brain.version + 1})...`);
  return await updateBrain(stats, brain);
}

async function updateBrain(stats, currentBrain) {
  const patterns = loadPatterns();
  const lessons = loadLessons().slice(-20); // 20 lessons terakhir
  const prompt = buildBrainUpdatePrompt(stats, patterns, lessons, currentBrain);

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
          { role: "system", content: BRAIN_UPDATE_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.4, // sedikit lebih kreatif buat reflection
      }),
    });

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error("Empty response from LLM");

    // Try direct parse first, then regex extraction
    let update;
    try {
      update = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        console.warn("  ⚠️ Brain: no JSON in response, keeping current brain");
        return currentBrain;
      }
      try {
        update = JSON.parse(match[0]);
      } catch (e2) {
        console.warn("  ⚠️ Brain: JSON parse failed, keeping current brain:", e2.message);
        return currentBrain;
      }
    }

    // Sanitize: enforce hard limits on generated brain
    const MAX_OPPSCORE = parseInt(process.env.MAX_BRAIN_OPPSCORE) || 60;
    const MAX_CONFIDENCE = parseInt(process.env.MAX_BRAIN_CONFIDENCE) || 70;
    const MAX_RED_FLAGS = 3;

    // Strip rules that set thresholds too high
    const cleanRules = (update.selfWrittenRules ?? []).filter(rule => {
      const ruleStr = rule.toLowerCase();
      // Remove rules blocking all meme tokens or requiring oppScore/confidence above limits
      const oppMatch = ruleStr.match(/opportunityscore\s*[>≥]\s*(\d+)/);
      const confMatch = ruleStr.match(/confidence\s*[>≥]\s*(\d+)/);
      if (oppMatch && parseInt(oppMatch[1]) > MAX_OPPSCORE) {
        console.warn(`  ⚠️ Brain: removed over-restrictive rule: "${rule.slice(0,80)}"`);
        return false;
      }
      if (confMatch && parseInt(confMatch[1]) > MAX_CONFIDENCE) {
        console.warn(`  ⚠️ Brain: removed over-restrictive rule: "${rule.slice(0,80)}"`);
        return false;
      }
      return true;
    });

    // Cap red flags at MAX_RED_FLAGS
    const cleanRedFlags = (update.redFlags ?? []).slice(0, MAX_RED_FLAGS);
    if ((update.redFlags ?? []).length > MAX_RED_FLAGS) {
      console.warn(`  ⚠️ Brain: trimmed red flags from ${update.redFlags.length} to ${MAX_RED_FLAGS}`);
    }

    // Clamp confidenceBias
    const bias = Math.max(-10, Math.min(10, update.confidenceBias ?? 0));

    const newBrain = {
      version: currentBrain.version + 1,
      lastUpdated: new Date().toISOString(),
      ...update,
      selfWrittenRules: cleanRules,
      redFlags: cleanRedFlags,
      confidenceBias: bias,
    };

    saveBrain(newBrain);

    console.log(`  ✅ Brain updated to v${newBrain.version}`);
    console.log(`  💭 Reflection: ${newBrain.latestReflection?.slice(0, 100)}...`);
    console.log(`  📜 Self-written rules: ${newBrain.selfWrittenRules?.length}`);
    console.log(`  🚩 Red flags: ${newBrain.redFlags?.length} | ✅ Green flags: ${newBrain.greenFlags?.length}`);

    return newBrain;

  } catch (err) {
    console.error("  ❌ Brain update failed:", err.message);
    return currentBrain;
  }
}

// ─── Prompts ──────────────────────────────────────────────────────────

const BRAIN_UPDATE_SYSTEM_PROMPT = `You are a self-improving DeFi trading AI that writes your own trading rules based on experience.

You will receive: trade stats, discovered patterns, and lessons from closed trades.
Your task: synthesize everything into updated beliefs, rules, and flags.

These rules will be injected into your own decision-making prompt — so write them in second person ("You should...", "Never open when...", "Prefer pools where...").

HARD CONSTRAINTS — these limits are MANDATORY and cannot be overridden:
- NEVER write rules requiring opportunityScore > 60 (keep threshold low to allow more trades)
- NEVER write rules requiring confidence > 70 (the agent must be allowed to trade at 45+)
- NEVER write rules that block ALL meme/new tokens as a category
- NEVER add more than 3 red flags total — too many red flags = no trades
- Rules must be PERMISSIVE, not restrictive. Goal is to trade more, not less.
- If win rate is low, the fix is better entry selection — NOT higher thresholds

Respond ONLY in this JSON format:
{
  "selfWrittenRules": [
    "<rule you've written for yourself based on experience, max 8 rules>",
    ...
  ],
  "marketBeliefs": [
    "<current belief about market conditions based on recent performance>",
    ...
  ],
  "strategyPreferences": {
    "spot": { "preferred": true|false, "conditions": "<when to use>" },
    "curve": { "preferred": true|false, "conditions": "<when to use>" },
    "bid-ask": { "preferred": true|false, "conditions": "<when to use>" }
  },
  "redFlags": [
    "<condition that should always trigger SKIP — max 3 flags, keep broad>",
    ...
  ],
  "greenFlags": [
    "<condition that should always trigger OPEN consideration>",
    ...
  ],
  "latestReflection": "<2-3 sentence honest reflection on performance and what to change>",
  "confidenceBias": <number between -10 and +10>
}

Be specific but permissive. Max 8 selfWrittenRules. Max 3 red flags. Max 5 green flags.`;

function buildBrainUpdatePrompt(stats, patterns, lessons, currentBrain) {
  return `You are updating your own trading brain. Here's your current state:

=== CURRENT PERFORMANCE ===
Total trades: ${stats.totalTrades}
Hit rate: ${stats.hitRate}%
Avg P&L: ${stats.avgPnlPercent}%
Total P&L: ${stats.totalPnlSol} SOL

=== DISCOVERED PATTERNS ===
${patterns.topInsight ?? "No patterns yet"}
Best conditions: ${(patterns.bestConditions ?? []).join(", ") || "unknown"}
Worst conditions: ${(patterns.worstConditions ?? []).join(", ") || "unknown"}
Suggested changes: ${(patterns.suggestedRuleChanges ?? []).join(", ") || "none"}

=== RECENT LESSONS (last 20 trades) ===
${lessons.map((l) => `[${l.outcome}] ${l.strategy} | ${l.lesson}`).join("\n") || "No lessons yet"}

=== YOUR CURRENT RULES (v${currentBrain.version}) ===
${(currentBrain.selfWrittenRules ?? []).join("\n") || "No rules yet — this is your first update"}

=== YOUR CURRENT RED FLAGS ===
${(currentBrain.redFlags ?? []).join("\n") || "None yet"}

=== YOUR CURRENT GREEN FLAGS ===
${(currentBrain.greenFlags ?? []).join("\n") || "None yet"}

Based on all this experience, rewrite and improve your rules. 
Keep what works. Remove what doesn't. Add new insights.
Be honest about your weaknesses.`;
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
 * Inject brain ke dalam LLM prompt tiap loop
 */
export function getBrainContextForLLM() {
  const brain = loadBrain();

  if (brain.version === 0) {
    return "Brain not initialized yet — no self-written rules.";
  }

  const lines = [
    `=== AGENT BRAIN v${brain.version} (self-written rules) ===`,
    ``,
    `YOUR RULES:`,
    ...(brain.selfWrittenRules ?? []).map((r, i) => `${i + 1}. ${r}`),
    ``,
    `GREEN FLAGS (lean toward opening):`,
    ...(brain.greenFlags ?? []).map((f) => `  ✅ ${f}`),
    ``,
    `RED FLAGS (always skip):`,
    ...(brain.redFlags ?? []).map((f) => `  🚩 ${f}`),
    ``,
    `CURRENT MARKET BELIEFS:`,
    ...(brain.marketBeliefs ?? []).map((b) => `  • ${b}`),
    ``,
    `CONFIDENCE ADJUSTMENT: ${brain.confidenceBias >= 0 ? "+" : ""}${brain.confidenceBias} points`,
    ``,
    `LATEST REFLECTION: ${brain.latestReflection}`,
  ];

  return lines.join("\n");
}
