// src-vps/cooldownManager.js
// Token cooldown tracker — per-reason durations.
//
// Losses / risk exits → long cooldown (let the dust settle before re-entering).
// Profit / neutral exits → short cooldown (re-enter quickly if the opportunity repeats).

import fs from "fs";
import path from "path";

const COOLDOWN_FILE = path.resolve("data/token_cooldown.json");
const DEFAULT_HOURS = Number(process.env.TOKEN_COOLDOWN_HOURS) || 0.5;

const QUOTE_TOKENS = ["USDC", "USDT", "SOL", "WSOL", "WBTC", "WETH", "BUSD", "DAI", "MSOL", "JITOSOL"];

// Hours of cooldown keyed by exit reason.
// MAX_HOLD is resolved dynamically (loss → MAX_HOLD_LOSS, profit → MAX_HOLD_PROFIT).
const COOLDOWN_HOURS_BY_REASON = {
  SL: 3,
  EMERGENCY: 3,
  OOR_LEFT: 1,
  MAX_HOLD_LOSS: 1,
  TRAILING_TP: 0.25,
  FEE_TP: 0.25,
  TP: 0.25,
  REBALANCE: 0.25,
  MAX_HOLD_PROFIT: 0.25,
  OOR_RIGHT: 0.5,
};

export function extractTokenSymbol(poolName) {
  if (!poolName) return null;
  const parts = poolName.toUpperCase().split(/[-\/\s]/);
  return parts.find(p => p.length > 0 && !QUOTE_TOKENS.includes(p)) ?? null;
}

function resolveHours(reason, pnlPct) {
  const r = (reason || "").toUpperCase();
  if (r === "MAX_HOLD") {
    return (typeof pnlPct === "number" && pnlPct < 0)
      ? COOLDOWN_HOURS_BY_REASON.MAX_HOLD_LOSS
      : COOLDOWN_HOURS_BY_REASON.MAX_HOLD_PROFIT;
  }
  if (COOLDOWN_HOURS_BY_REASON[r] != null) return COOLDOWN_HOURS_BY_REASON[r];
  return DEFAULT_HOURS;
}

function load() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf-8"));
  } catch {}
  return {};
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(COOLDOWN_FILE), { recursive: true });
    fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error("[cooldown] Save error:", e.message); }
}

// Legacy string entries (pre-reason format) stored ISO of last trade and used a
// fixed 6h window. Interpret them the same way so old state keeps working.
function entryRemainingMs(entry) {
  if (!entry) return 0;
  if (typeof entry === "string") {
    const legacyMs = 6 * 3_600_000;
    return Math.max(0, legacyMs - (Date.now() - new Date(entry).getTime()));
  }
  const expiresAt = entry.expiresAt ? new Date(entry.expiresAt).getTime() : 0;
  return Math.max(0, expiresAt - Date.now());
}

export function formatRemaining(ms) {
  if (ms <= 0) return "0m";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function isOnCooldown(tokenSymbol) {
  if (!tokenSymbol) return false;
  const key = tokenSymbol.toUpperCase();
  const data = load();
  const entry = data[key];
  if (!entry) return false;
  const ms = entryRemainingMs(entry);
  if (ms > 0) {
    const reason = typeof entry === "object" && entry.reason ? entry.reason : "legacy";
    console.log(`  ⏳ ${key} cooldown: ${formatRemaining(ms)} remaining [${reason}]`);
    return true;
  }
  return false;
}

export function setCooldown(tokenSymbol, opts = {}) {
  if (!tokenSymbol) return;
  const { reason = null, pnlPct = null } = opts;
  const key = tokenSymbol.toUpperCase();
  const hours = resolveHours(reason, pnlPct);
  const data = load();
  const now = Date.now();
  data[key] = {
    setAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * 3_600_000).toISOString(),
    reason: reason ?? "DEFAULT",
    pnlPct: typeof pnlPct === "number" ? parseFloat(pnlPct.toFixed(2)) : null,
  };
  save(data);
  const pnlStr = typeof pnlPct === "number" ? ` pnl=${pnlPct.toFixed(1)}%` : "";
  console.log(`  🔒 Cooldown set: ${key} ${hours}h [${reason ?? "DEFAULT"}${pnlStr}]`);
}

export function getCooldownRemaining(tokenSymbol) {
  if (!tokenSymbol) return "0m";
  const data = load();
  return formatRemaining(entryRemainingMs(data[tokenSymbol.toUpperCase()]));
}

export function getActiveCooldowns() {
  const data = load();
  return Object.entries(data)
    .map(([symbol, entry]) => ({ symbol, entry, ms: entryRemainingMs(entry) }))
    .filter(({ ms }) => ms > 0)
    .map(({ symbol, entry, ms }) => ({
      symbol,
      remaining: formatRemaining(ms),
      reason: typeof entry === "object" && entry.reason ? entry.reason : "legacy",
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}
