// src-vps/blacklistManager.js
// Blacklist manager for high-mcap altcoins, manually banned tokens, and auto-blacklisted losers

import fs from "fs";
import path from "path";

const LOSS_FILE = path.resolve("data/token_losses.json");
const OOR_FILE = path.resolve("data/oor_strikes.json");
const PERM_BL_FILE = path.resolve("data/permanent_blacklist.json");
const OOR_COOLDOWN_FILE = path.resolve("data/oor_cooldown.json");
const AUTO_BL_THRESHOLD = 5; // auto-blacklist after N losses
const BLACKLIST_DECAY_DAYS = 7; // auto-unblacklist after N days

// Tokens that are ALWAYS blacklisted regardless of .env (large-cap, not meme)
const HARDCODED_BLACKLIST = new Set(["JUP", "JUPSOL", "JLP", "WBTC", "WETH", "CBBTC", "RAY", "ORCA", "BABYTRUMP"]);

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
// Format: { "SYM": { count: N, blacklistedAt: ISO|null } }
// Migrates from old format { "SYM": N } on read
function loadLosses() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOSS_FILE, "utf-8"));
    let migrated = false;
    const data = {};
    for (const [sym, val] of Object.entries(raw)) {
      if (typeof val === "number") {
        data[sym] = { count: val, blacklistedAt: val >= AUTO_BL_THRESHOLD ? new Date().toISOString() : null };
        migrated = true;
      } else {
        data[sym] = val;
      }
    }
    if (migrated) saveLosses(data);
    return data;
  } catch { return {}; }
}
function saveLosses(data) {
  try {
    fs.mkdirSync(path.dirname(LOSS_FILE), { recursive: true });
    fs.writeFileSync(LOSS_FILE, JSON.stringify(data, null, 2));
  } catch {}
}
function getLossCount(losses, sym) {
  const entry = losses[sym];
  return typeof entry === "number" ? entry : (entry?.count ?? 0);
}

export function recordTokenLoss(poolName) {
  const syms = extractSymbols(poolName).filter(s => !QUOTE_TOKENS.has(s));
  if (syms.length === 0) return;
  const sym = syms[0];
  const losses = loadLosses();
  const prev = losses[sym]?.count ?? 0;
  const newCount = prev + 1;
  losses[sym] = {
    count: newCount,
    blacklistedAt: newCount >= AUTO_BL_THRESHOLD ? (losses[sym]?.blacklistedAt ?? new Date().toISOString()) : null,
  };
  saveLosses(losses);
  if (newCount >= AUTO_BL_THRESHOLD) {
    console.log(`  [AutoBlacklist] ${sym} blocked — ${newCount} losses`);
  }
  return { symbol: sym, count: newCount };
}

export function getTokenLosses() {
  const losses = loadLosses();
  // Return { SYM: count } for backward compat with display code that expects numbers
  const result = {};
  for (const [sym, val] of Object.entries(losses)) {
    result[sym] = typeof val === "number" ? val : (val?.count ?? 0);
  }
  return result;
}

// Return full data with timestamps for display filtering
export function getTokenLossesWithDates() {
  return loadLosses();
}

export async function manualBlacklist(symbol) {
  let input = symbol;

  // Detect CA address (base58, 32-44 chars) and resolve to symbol via DexScreener
  const CA_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (CA_REGEX.test(input)) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${input}`, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const pair = data?.pairs?.[0];
      if (pair?.baseToken?.symbol) {
        const resolved = pair.baseToken.symbol.toUpperCase();
        console.log(`[Blacklist] CA resolved: ${input.slice(0, 8)}... → ${resolved}`);
        input = resolved;
      } else {
        console.log(`[Blacklist] CA ${input.slice(0, 8)}... could not be resolved — no DexScreener pair found`);
        return `CA ${input.slice(0, 8)}... (unresolved)`;
      }
    } catch (err) {
      console.log(`[Blacklist] CA resolution failed: ${err.message}`);
      return `CA ${input.slice(0, 8)}... (resolution error)`;
    }
  }

  // Extract token symbols — handles both "STONKS" and "stonks-SOL" inputs
  const syms = extractSymbols(input).filter(s => !QUOTE_TOKENS.has(s));
  if (syms.length === 0) return input.toUpperCase();
  const losses = loadLosses();
  for (const sym of syms) {
    const prev = losses[sym]?.count ?? 0;
    losses[sym] = { count: Math.max(prev, AUTO_BL_THRESHOLD), blacklistedAt: losses[sym]?.blacklistedAt ?? new Date().toISOString() };
  }
  saveLosses(losses);
  console.log(`[Blacklist] Manual blacklist: ${syms.join(", ")} (count set to ${AUTO_BL_THRESHOLD})`);
  return syms.join(", ");
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
  const lossCount = losses[sym]?.count ?? 0;
  const oorCount = oor[sym] ?? 0;

  // Rule 4: loss >= 7 → permanent blacklist
  if (lossCount >= 7) {
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
    const lc = losses[sym]?.count ?? 0;
    if (lc >= AUTO_BL_THRESHOLD) {
      return { blacklisted: true, reason: `${sym} auto-blacklisted (${lc} losses)` };
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
  const autoBL = Object.entries(losses).filter(([, v]) => (v?.count ?? 0) >= AUTO_BL_THRESHOLD).map(([s]) => s);
  const permBL = Object.keys(perm);
  return [...new Set([...STATIC_BLACKLIST, ...autoBL, ...permBL])];
}

// Time decay: auto-unblacklist tokens after BLACKLIST_DECAY_DAYS
// Does NOT touch: hardcoded, static (.env), or permanent blacklist
export function decayBlacklist() {
  const losses = loadLosses();
  const perm = loadPermBL();
  const now = Date.now();
  const decayMs = BLACKLIST_DECAY_DAYS * 86_400_000;
  let decayed = 0;

  for (const [sym, entry] of Object.entries(losses)) {
    if ((entry?.count ?? 0) < AUTO_BL_THRESHOLD) continue;
    if (!entry.blacklistedAt) continue;
    // Skip permanent, hardcoded, or static tokens
    if (perm[sym] || HARDCODED_BLACKLIST.has(sym) || STATIC_BLACKLIST.includes(sym)) continue;
    const age = now - new Date(entry.blacklistedAt).getTime();
    if (age >= decayMs) {
      console.log(`  ♻️ Unblacklisted: ${sym} (expired ${Math.floor(age / 86_400_000)}d)`);
      losses[sym] = { count: 2, blacklistedAt: null }; // drop below threshold but keep history
      decayed++;
    }
  }
  if (decayed > 0) saveLosses(losses);
  return decayed;
}
