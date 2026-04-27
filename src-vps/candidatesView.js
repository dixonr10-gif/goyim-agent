// candidatesView.js — formatter + paginator for /candidates and btn_candidates_p<N>
// Reads data/candidates.json (written at end of each hunter cycle that reached LLM).
// Page size: 5 candidates per page. Stale guard: reads daily_pnl_tracker.json
// (the actual tracker file per dailyCircuitBreaker.js header) for pause status.

import fs from "fs";
import path from "path";

const CANDIDATES_PATH = path.resolve("data/candidates.json");
const TRACKER_PATH = path.resolve("data/daily_pnl_tracker.json");
const PAGE_SIZE = 5;
const SAFE_LIMIT_CHARS = 3500; // Telegram hard limit ~4096; leave headroom

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getPauseStatus() {
  const t = readJsonSafe(TRACKER_PATH);
  if (!t || !t.paused || !t.pausedUntil) return { paused: false };
  // pausedUntil is an ISO string in this codebase (per dailyCircuitBreaker.js)
  const untilMs = new Date(t.pausedUntil).getTime();
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return { paused: false };
  const wibTime = new Date(untilMs).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return { paused: true, reason: t.pauseReason || "UNKNOWN", until: `${wibTime} WIB` };
}

function formatCandidate(c, idx) {
  const actionEmoji = {
    OPEN: "🟢",
    NOT_CHOSEN_BY_LLM: "⚪",
    SKIPPED_LLM: "🟡",
  }[c.decision] || "❓";

  const mods = [];
  const m = c.modifiers || {};
  if (m.poolMemAdj) mods.push(`pm=${m.poolMemAdj > 0 ? "+" : ""}${m.poolMemAdj}`);
  if (m.tvlDrainAdj) mods.push(`tvl=${m.tvlDrainAdj}`);
  if (m.ageBonus !== undefined && m.ageBonus !== null) {
    const tierShort = (c.ageTier || "?").split("_")[0];
    mods.push(`age=${m.ageBonus > 0 ? "+" : ""}${m.ageBonus}(${tierShort})`);
  }

  const cp = c.components || {};
  const compLine = `fee=${cp.feeScore ?? "?"} vol=${cp.volScore ?? "?"} mtm=${cp.momentumScore ?? "?"} oth=${cp.otherScore ?? "?"}`;

  const feeRatio = (c.fees24h && c.tvl) ? ((c.fees24h / c.tvl) * 100).toFixed(0) : "?";
  const ageH = (typeof c.ageHours === "number") ? c.ageHours.toFixed(1) : "?";

  let text = `${idx}. ${actionEmoji} <b>${esc(c.name)}</b> — score <b>${c.finalScore}</b>\n`;
  text += `   ${compLine}\n`;
  if (mods.length) text += `   mods: ${mods.join(" ")}\n`;
  text += `   fee/TVL ${feeRatio}% | organic ${c.organicScore ?? "?"} | age ${ageH}h\n`;
  if (c.decision === "OPEN" && c.llmConfidence != null) {
    const snippet = (c.llmRationaleSnippet || "").slice(0, 120);
    text += `   LLM conf=${c.llmConfidence}% — ${esc(snippet)}\n`;
  }
  return text;
}

export function formatPage(page = 1) {
  const data = readJsonSafe(CANDIDATES_PATH);
  const pause = getPauseStatus();

  if (pause.paused) {
    const lastScan = data?.lastScannedAt
      ? Math.round((Date.now() - data.lastScannedAt) / 60000)
      : "?";
    return {
      text:
        `⏸️ <b>Scan paused</b> (${esc(pause.reason)} until ${esc(pause.until)})\n\n` +
        `Last scan: ${lastScan} min ago\n\n` +
        `Resume to refresh candidates view.`,
      buttons: [],
    };
  }

  if (!data || !Array.isArray(data.candidates) || data.candidates.length === 0) {
    return {
      text: `📋 <b>Candidates</b>\n\nNo candidates yet. Wait for next hunter cycle (~10 min).`,
      buttons: [],
    };
  }

  // Decision 2: only LLM-evaluated pools
  const evaluated = data.candidates.filter(c =>
    ["OPEN", "NOT_CHOSEN_BY_LLM", "SKIPPED_LLM"].includes(c.decision)
  );

  if (evaluated.length === 0) {
    return {
      text:
        `📋 <b>Candidates</b>\n\n` +
        `No pools reached LLM evaluation in last cycle.\n` +
        `All pools dropped at pre-filter or hard-blocked.`,
      buttons: [],
    };
  }

  const totalPages = Math.max(1, Math.ceil(evaluated.length / PAGE_SIZE));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * PAGE_SIZE;
  const slice = evaluated.slice(start, start + PAGE_SIZE);

  const ageMin = data.lastScannedAt ? Math.round((Date.now() - data.lastScannedAt) / 60000) : "?";
  let text = `📋 <b>Candidates</b> — page ${safePage}/${totalPages} (${evaluated.length} pools, ${ageMin}m ago)\n\n`;
  slice.forEach((c, i) => { text += formatCandidate(c, start + i + 1) + "\n"; });

  if (text.length > SAFE_LIMIT_CHARS) {
    text = text.slice(0, SAFE_LIMIT_CHARS - 50) + "\n\n[truncated]";
  }

  const buttons = [];
  if (safePage > 1) buttons.push({ text: "⬅️ Prev", callback_data: `btn_candidates_p${safePage - 1}` });
  if (safePage < totalPages) buttons.push({ text: "Next ➡️", callback_data: `btn_candidates_p${safePage + 1}` });

  return { text, buttons };
}
