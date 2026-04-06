// src-vps/lpStudy.js
// Study top LP pools and extract lessons via LLM

import fs from "fs";
import path from "path";
import { config } from "../config.js";

const LP_LESSONS_FILE = path.resolve("data/lp_lessons.json");
const METEORA_API = "https://dlmm.datapi.meteora.ag";

function loadLpLessons() {
  try {
    if (fs.existsSync(LP_LESSONS_FILE)) return JSON.parse(fs.readFileSync(LP_LESSONS_FILE, "utf-8"));
  } catch {}
  return { lessons: [], lastStudied: null };
}

function saveLpLessons(data) {
  try {
    fs.mkdirSync(path.dirname(LP_LESSONS_FILE), { recursive: true });
    fs.writeFileSync(LP_LESSONS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error("[lpStudy] Save error:", e.message); }
}

async function fetchTopPools(limit = 10) {
  try {
    const res = await fetch(`${METEORA_API}/pools?page=1&limit=${limit}`, {
      signal: AbortSignal.timeout(15000),
      headers: { "Accept": "application/json" },
    });
    const text = await res.text();
    return JSON.parse(text)?.data ?? [];
  } catch (e) {
    console.error("[lpStudy] Fetch error:", e.message);
    return [];
  }
}

async function fetchPoolById(poolAddress) {
  try {
    const res = await fetch(`${METEORA_API}/pools/${poolAddress}`, {
      signal: AbortSignal.timeout(15000),
      headers: { "Accept": "application/json" },
    });
    const data = await res.json();
    return data ? [data] : [];
  } catch (e) {
    console.error("[lpStudy] Pool fetch error:", e.message);
    return [];
  }
}

async function studyPoolsWithLLM(pools) {
  const summaries = pools.slice(0, 8).map(p => ({
    name: p.name,
    tvl: Math.round(p.tvl ?? 0),
    volume24h: Math.round(p.volume?.["24h"] ?? 0),
    feeApr: ((p.apr ?? 0) * 100).toFixed(1) + "%",
    binStep: p.pool_config?.bin_step,
    volTvlRatio: p.tvl > 0 ? (p.volume?.["24h"] / p.tvl).toFixed(2) : "N/A",
  }));

  const prompt = `You are analyzing top Meteora DLMM liquidity pools on Solana for an AI LP agent.

Top pools right now:
${JSON.stringify(summaries, null, 2)}

Extract 4-8 concise actionable lessons for the LP agent. Focus on:
- What volume/TVL ratios indicate healthy organic activity?
- What fee APR % and bin step combinations earn the most?
- What patterns distinguish high-performance pools from traps?
- When to AVOID a pool that looks good on the surface?

Respond ONLY with a valid JSON array, no markdown:
[{"lesson": "...", "confidence": 0-100, "applies_to": "entry|exit|filter|general"}]`;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.openRouterApiKey}`,
      },
      body: JSON.stringify({
        model: config.openRouterModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    const match = content.match(/\[[\s\S]+\]/);
    if (match) return JSON.parse(match[0]);
    console.warn("[lpStudy] LLM returned no JSON array");
  } catch (e) {
    console.error("[lpStudy] LLM error:", e.message);
  }
  return [];
}

export async function studyTopLPs(poolAddress = null) {
  console.log(`📚 LP Study: ${poolAddress ? `Analyzing pool ${poolAddress.slice(0, 8)}...` : "Fetching top pools..."}`);

  const pools = poolAddress ? await fetchPoolById(poolAddress) : await fetchTopPools(10);

  if (pools.length === 0) {
    console.warn("[lpStudy] No pools found");
    return { lessons: [], studiedAt: new Date().toISOString() };
  }

  console.log(`📚 LP Study: Analyzing ${pools.length} pool(s) with LLM...`);
  const newLessons = await studyPoolsWithLLM(pools);

  const existing = loadLpLessons();
  const tagged = newLessons.map(l => ({
    ...l,
    studiedAt: new Date().toISOString(),
    source: poolAddress ? `pool:${poolAddress.slice(0, 8)}` : "top_pools",
  }));

  const allLessons = [...tagged, ...(existing.lessons ?? [])].slice(0, 50);
  const result = { lessons: allLessons, lastStudied: new Date().toISOString() };
  saveLpLessons(result);

  console.log(`📚 LP Study: Saved ${tagged.length} new lessons (${allLessons.length} total)`);
  return result;
}

export function getLpLessonsForLLM(limit = 5) {
  const data = loadLpLessons();
  if (!data.lessons?.length) return "No LP study lessons yet.";
  return data.lessons
    .slice(0, limit)
    .map(l => `• [${l.confidence}%] ${l.lesson}`)
    .join("\n");
}
