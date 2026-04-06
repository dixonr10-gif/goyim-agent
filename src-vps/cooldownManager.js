// src-vps/cooldownManager.js
// Token cooldown tracker — prevents re-entering same token within COOLDOWN_HOURS

import fs from "fs";
import path from "path";

const COOLDOWN_FILE = path.resolve("data/token_cooldown.json");
const COOLDOWN_HOURS = Number(process.env.TOKEN_COOLDOWN_HOURS) || 6;
const COOLDOWN_MS = COOLDOWN_HOURS * 3_600_000;

const QUOTE_TOKENS = ["USDC", "USDT", "SOL", "WSOL", "WBTC", "WETH", "BUSD", "DAI", "MSOL", "JITOSOL"];

// Extract the non-quote token symbol from a pool name like "ANIME-SOL" → "ANIME"
export function extractTokenSymbol(poolName) {
  if (!poolName) return null;
  const parts = poolName.toUpperCase().split(/[-\/\s]/);
  return parts.find(p => p.length > 0 && !QUOTE_TOKENS.includes(p)) ?? null;
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

function remainingMs(lastTradedIso) {
  return Math.max(0, COOLDOWN_MS - (Date.now() - new Date(lastTradedIso).getTime()));
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
  const lastTraded = data[key];
  if (!lastTraded) return false;
  const ms = remainingMs(lastTraded);
  if (ms > 0) {
    console.log(`  ⏳ ${key} cooldown: ${formatRemaining(ms)} remaining`);
    return true;
  }
  return false;
}

export function setCooldown(tokenSymbol) {
  if (!tokenSymbol) return;
  const key = tokenSymbol.toUpperCase();
  const data = load();
  data[key] = new Date().toISOString();
  save(data);
  console.log(`  🔒 Cooldown set: ${key} (${COOLDOWN_HOURS}h)`);
}

export function getCooldownRemaining(tokenSymbol) {
  if (!tokenSymbol) return "0m";
  const data = load();
  const lastTraded = data[tokenSymbol.toUpperCase()];
  if (!lastTraded) return "0m";
  return formatRemaining(remainingMs(lastTraded));
}

export function getActiveCooldowns() {
  const data = load();
  return Object.entries(data)
    .map(([symbol, ts]) => ({ symbol, ms: remainingMs(ts) }))
    .filter(({ ms }) => ms > 0)
    .map(({ symbol, ms }) => ({ symbol, remaining: formatRemaining(ms) }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}
