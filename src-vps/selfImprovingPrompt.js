// src/selfImprovingPrompt.js
// DISABLED — brain self-improvement caused paralysis (oppScore>=80, APR>40% loops)
// Kept as stubs so all imports still work. EVOLVE handles threshold tuning instead.

import fs from "fs";

const BRAIN_FILE = "./data/agent_brain.json";

function emptyBrain() {
  return {
    version: 0,
    lastUpdated: null,
    selfWrittenRules: [],
    marketBeliefs: [],
    strategyPreferences: {},
    redFlags: [],
    greenFlags: [],
    latestReflection: "",
    confidenceBias: 0,
  };
}

// No-op — brain updates disabled
export async function maybeUpdateBrain(_stats) {
  console.log("  🧠 Brain: disabled (using EVOLVE only)");
  return loadBrain();
}

export function loadBrain() {
  try {
    if (!fs.existsSync(BRAIN_FILE)) return emptyBrain();
    return JSON.parse(fs.readFileSync(BRAIN_FILE, "utf-8"));
  } catch {
    return emptyBrain();
  }
}

// Returns empty string — no brain rules injected into LLM prompt
export function getBrainContextForLLM() {
  return "";
}
