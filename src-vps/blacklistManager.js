// src-vps/blacklistManager.js
// Blacklist manager for high-mcap altcoins, manually banned tokens, and auto-blacklisted losers

import fs from "fs";
import path from "path";

const LOSS_FILE = path.resolve("data/token_losses.json");
const OOR_FILE = path.resolve("data/oor_strikes.json");
const PERM_BL_FILE = path.resolve("data/permanent_blacklist.json");
const OOR_COOLDOWN_FILE = path.resolve("data/oor_cooldown.json");
const AUTO_BL_THRESHOLD = 3; // auto-blacklist after N losses

// Tokens that are ALWAYS blacklisted regardless of .env (large-cap, not meme)
const HARDCODED_BLACKLIST = new Set(["JUP", "JUPSOL", "JLP", "WBTC", "WETH", "CBBTC", "RAY", "ORCA"]);

const STATIC_BLACKLIST = [
  ...HARDCODED_BLACKLIST,
  ...(process.env.BLACKLISTED_TOKENS ?? "BONK,WIF,POPCAT,PYTH,MNGO")
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean),
];

const QUOTE_TOKENS = new Set(["USDC","USDT","SOL","WSOL","WBTC","WETH","BUSD","DAI","MSOL","JITOSOL"]);

function extractSymbols(poolName) {
  if (!poolName) return [];
  return poolName.split(/[-\/\s]+/).map(s => s.toUpperCase().trim()).filter(Boolean);
}

// ── Token loss tracking ─────────────────────────────────────────────
function loadLosses() {
  try { return JSON.parse(fs.readFileSync(LOSS_FILE, "utf-8")); } catch { return {}; }
}
function saveLosses(data) {
  try {
    fs.mkdirSync(path.dirname(LOSS_FILE), { recursive: true });
    fs.writeFileSync(LOSS_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

export function recordTokenLoss(poolName) {
  const syms = extractSymbols(poolName).filter(s => !QUOTE_TOKENS.has(s));
  if (syms.length === 0) return;
  const sym = syms[0];
  const losses = loadLosses();
  losses[sym] = (losses[sym] ?? 0) + 1;
  saveLosses(losses);
  if (losses[sym] >= AUTO_BL_THRESHOLD) {
    console.log(`  [AutoBlacklist] ${sym} blocked — ${losses[sym]} losses`);
  }
  return { symbol: sym, count: losses[sym] };
}

export function getTokenLosses() { return loadLosses(); }

export function manualBlacklist(symbol) {
  const upper = symbol.toUpperCase();
  const losses = loadLosses();
  losses[upper] = Math.max(losses[upper] ?? 0, 3); // ensure >= threshold
  saveLosses(losses);
  return upper;
}

export function unblacklistToken(symbol) {
  const losses = loadLosses();
  const upper = symbol.toUpperCase();
  if (losses[upper] !== undefined) {
    delete losses[upper];
    saveLosses(losses);
    return true;
  }
  return false;
}

// ── OOR strike tracking ─────────────────────────────────────────────
function loadOOR() { try { return JSON.parse(fs.readFileSync(OOR_FILE, "utf-8")); } catch { return {}; } }
function saveOOR(d) { try { fs.mkdirSync(path.dirname(OOR_FILE), { recursive: true }); fs.writeFileSync(OOR_FILE, JSON.stringify(d, null, 2)); } catch {} }
function loadPermBL() { try { return JSON.parse(fs.readFileSync(PERM_BL_FILE, "utf-8")); } catch { return {}; } }
function savePermBL(d) { try { fs.mkdirSync(path.dirname(PERM_BL_FILE), { recursive: true }); fs.writeFileSync(PERM_BL_FILE, JSON.stringify(d, null, 2)); } catch {} }
function loadOORCooldown() { try { return JSON.parse(fs.readFileSync(OOR_COOLDOWN_FILE, "utf-8")); } catch { return {}; } }
function saveOORCooldown(d) { try { fs.mkdirSync(path.dirname(OOR_COOLDOWN_FILE), { recursive: true }); fs.writeFileSync(OOR_COOLDOWN_FILE, JSON.stringify(d, null, 2)); } catch {} }

export function recordOORStrike(poolName) {
  const syms = extractSymbols(poolName).filter(s => !QUOTE_TOKENS.has(s));
  if (syms.length === 0) return;
  const sym = syms[0];
  const oor = loadOOR();
  oor[sym] = (oor[sym] ?? 0) + 1;
  saveOOR(oor);
  // Apply coordination rules
  applyCoordinationRules(sym);
  return { symbol: sym, count: oor[sym] };
}

export function getOORStrikes() { return loadOOR(); }
export function getOORCooldowns() { return loadOORCooldown(); }

function applyCoordinationRules(sym) {
  const losses = loadLosses();
  const oor = loadOOR();
  const lossCount = losses[sym] ?? 0;
  const oorCount = oor[sym] ?? 0;

  // Rule 4: loss >= 5 → permanent blacklist
  if (lossCount >= 5) {
    const perm = loadPermBL();
    if (!perm[sym]) {
      perm[sym] = { reason: `${lossCount} losses`, since: new Date().toISOString() };
      savePermBL(perm);
      console.log(`  [PermBlacklist] ${sym} permanently blacklisted — ${lossCount} losses`);
    }
    return;
  }
  // Rule 1: loss >= 3 → auto-blacklist (handled by existing threshold)
  if (lossCount >= AUTO_BL_THRESHOLD) return;

  // Rule 3: loss >= 2 AND oor >= 2 → cooldown 12h
  if (lossCount >= 2 && oorCount >= 2) {
    setOORCooldown(sym, 12);
    console.log(`  [Coordination] ${sym}: ${lossCount} loss + ${oorCount} OOR → 12h cooldown`);
    return;
  }
  // Rule 2: oor >= 4 → cooldown 6h
  if (oorCount >= 4) {
    setOORCooldown(sym, 6);
    console.log(`  [Coordination] ${sym}: ${oorCount} OOR strikes → 6h cooldown`);
  }
}

function setOORCooldown(sym, hours) {
  const cd = loadOORCooldown();
  cd[sym] = { until: new Date(Date.now() + hours * 3_600_000).toISOString(), hours };
  saveOORCooldown(cd);
}

export function isOnOORCooldown(sym) {
  const cd = loadOORCooldown();
  const entry = cd[sym?.toUpperCase()];
  if (!entry) return false;
  return new Date(entry.until) > new Date();
}

export function isTokenBlacklisted(poolName) {
  const symbols = extractSymbols(poolName);
  for (const sym of symbols) {
    if (QUOTE_TOKENS.has(sym)) continue;
    if (HARDCODED_BLACKLIST.has(sym)) {
      return { blacklisted: true, reason: `${sym} is permanently blacklisted (large-cap, not meme)` };
    }
    if (STATIC_BLACKLIST.includes(sym)) {
      return { blacklisted: true, reason: `${sym} is blacklisted (high-mcap altcoin)` };
    }
    // Permanent blacklist
    const perm = loadPermBL();
    if (perm[sym]) {
      return { blacklisted: true, reason: `${sym} permanently blacklisted (${perm[sym].reason})` };
    }
    // Auto-blacklist: loss >= 3
    const losses = loadLosses();
    if ((losses[sym] ?? 0) >= AUTO_BL_THRESHOLD) {
      return { blacklisted: true, reason: `${sym} auto-blacklisted (${losses[sym]} losses)` };
    }
    // OOR cooldown
    if (isOnOORCooldown(sym)) {
      const cd = loadOORCooldown();
      const remaining = Math.max(0, new Date(cd[sym].until) - Date.now());
      const h = Math.floor(remaining / 3_600_000);
      const m = Math.floor((remaining % 3_600_000) / 60_000);
      return { blacklisted: true, reason: `${sym} on OOR cooldown (${h}h ${m}m remaining)` };
    }
  }
  return { blacklisted: false };
}

export function getBlacklist() {
  const losses = loadLosses();
  const perm = loadPermBL();
  const autoBL = Object.entries(losses).filter(([, c]) => c >= AUTO_BL_THRESHOLD).map(([s]) => s);
  const permBL = Object.keys(perm);
  return [...new Set([...STATIC_BLACKLIST, ...autoBL, ...permBL])];
}
