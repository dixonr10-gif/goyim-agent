// src-vps/cooldownManager.js
// Token cooldown tracker.
//
// Rules (see setCooldown):
//   - Profit exit → 30min cooldown, consecutiveWins += 1
//   - Loss exit (SL/EMERGENCY or pnl < 0) → 4h cooldown, consecutiveWins = 0
//   - deploys24h ≥ 4 AND consecutiveWins < 3 → 24h cooldown
//   - deploys24h ≥ 4 AND consecutiveWins ≥ 3 → normal (up to 6x)
//   - deploys24h ≥ 6 → 24h cooldown regardless

import fs from "fs";
import path from "path";

const COOLDOWN_FILE = path.resolve("data/token_cooldown.json");
const WINDOW_MS = 24 * 3_600_000;

const QUOTE_TOKENS = ["USDC", "USDT", "SOL", "WSOL", "WBTC", "WETH", "BUSD", "DAI", "MSOL", "JITOSOL"];

// Whitelist of close reasons that should NOT trigger a cooldown timer.
// Phase 2 redesign 2026-04-27: pool that closes via these reasons isn't
// structurally bad — position aged out (MAX_HOLD), drifted out of range
// (OOR/OOR_LEFT/OOR_RIGHT), or fee yield decayed (FEE_APR_FLOOR). These
// pools deserve immediate re-eligibility on the next hunter cycle.
// isBlockedByMaxCap (deploys24h cap) remains the concentration governor.
const NON_LOSS_REASONS = new Set([
  "MAX_HOLD",
  "OOR",
  "OOR_LEFT",
  "OOR_RIGHT",
  "FEE_APR_FLOOR",
]);

function pruneDeploys(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const cutoff = Date.now() - WINDOW_MS;
  const deploys = Array.isArray(entry.deploys24h) ? entry.deploys24h : [];
  entry.deploys24h = deploys.filter(ts => new Date(ts).getTime() >= cutoff);
  return entry;
}

export function extractTokenSymbol(poolName) {
  if (!poolName) return null;
  const parts = poolName.toUpperCase().split(/[-\/\s]/);
  return parts.find(p => p.length > 0 && !QUOTE_TOKENS.includes(p)) ?? null;
}

// SL/EMERGENCY always loss; otherwise classify by pnl sign. Unknown pnl → neutral
// (no change to consecutiveWins, default to 30min cooldown).
function classifyExit(reason, pnlPct) {
  const r = (reason || "").toUpperCase();
  if (r === "SL" || r === "EMERGENCY" || r === "EMERGENCY_SL") return "loss";
  if (typeof pnlPct === "number") return pnlPct >= 0 ? "profit" : "loss";
  return "neutral";
}

function formatHoursLabel(hours) {
  if (hours >= 1) return `${hours}h`;
  return `${Math.round(hours * 60)}min`;
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
  const data = load();
  const now = Date.now();
  const existing = pruneDeploys(data[key]) ?? {};

  // REBALANCE is a relocation event, not a finalized trade outcome.
  // Skip wins-streak update and deploys24h increment — only set a short
  // re-entry cooldown so the agent doesn't immediately re-pick the same pool.
  if ((reason || "").toUpperCase() === "REBALANCE") {
    existing.setAt = new Date(now).toISOString();
    existing.expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
    existing.reason = "REBALANCE";
    data[key] = existing;
    save(data);
    console.log(`[Cooldown] ${key}: REBALANCE → 30min cooldown (no wins/deploys update)`);
    return;
  }

  const deploys = Array.isArray(existing.deploys24h) ? [...existing.deploys24h] : [];
  deploys.push(new Date(now).toISOString());

  const prevWins = existing.consecutiveWins ?? 0;
  const exitType = classifyExit(reason, pnlPct);
  let consecutiveWins;
  if (exitType === "profit") consecutiveWins = prevWins + 1;
  else if (exitType === "loss") consecutiveWins = 0;
  else consecutiveWins = prevWins;

  const count = deploys.length;
  const isNonLoss = NON_LOSS_REASONS.has((reason || "").toUpperCase());
  let hours;
  if (count >= 6) hours = 24;
  else if (count >= 4 && consecutiveWins < 3) hours = 24;
  else if (isNonLoss) hours = 0;            // pool wasn't bad — immediate re-eligibility
  else if (exitType === "loss") hours = 4;
  else hours = 0.5;

  data[key] = {
    setAt: new Date(now).toISOString(),
    expiresAt: new Date(now + hours * 3_600_000).toISOString(),
    reason: reason ?? "DEFAULT",
    pnlPct: typeof pnlPct === "number" ? parseFloat(pnlPct.toFixed(2)) : null,
    consecutiveWins,
    deploys24h: deploys,
  };
  save(data);
  if (hours === 0 && isNonLoss) {
    console.log(`[Cooldown] ${key}: ${reason} → 0min cooldown (whitelist), consecutiveWins=${consecutiveWins}, deploys24h=${count}`);
  } else {
    console.log(`[Cooldown] ${key}: ${reason ?? "DEFAULT"} → ${formatHoursLabel(hours)} cooldown, consecutiveWins=${consecutiveWins}, deploys24h=${count}`);
  }
}

// Hard-block before open if rule 3 bar says "no": covers the case where the
// stored cooldown already expired (e.g., agent restart) but deploy count still
// sits in the penalty window.
export function isBlockedByMaxCap(tokenSymbol) {
  if (!tokenSymbol) return false;
  const key = tokenSymbol.toUpperCase();
  const data = load();
  const entry = pruneDeploys(data[key]);
  if (!entry || !Array.isArray(entry.deploys24h)) return false;
  const count = entry.deploys24h.length;
  const wins = entry.consecutiveWins ?? 0;
  if (count >= 6) {
    console.log(`  🚫 ${key} deploy cap: ${count}/24h ≥ 6 — blocked`);
    return true;
  }
  if (count >= 4 && wins < 3) {
    console.log(`  🚫 ${key} deploy cap: ${count}/24h, consecutiveWins=${wins} < 3 — blocked`);
    return true;
  }
  return false;
}

export function getDeployCount24h(tokenSymbol) {
  if (!tokenSymbol) return 0;
  const data = load();
  const entry = pruneDeploys(data[tokenSymbol.toUpperCase()]);
  return entry && Array.isArray(entry.deploys24h) ? entry.deploys24h.length : 0;
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
