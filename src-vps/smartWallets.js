// src/smartWallets.js
// Smart wallet tracker — monitors top LPers via LPAgent API

import fs from "fs";
import path from "path";

const SMART_WALLETS_FILE = path.resolve("data/smart_wallets.json");
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";
const LPAGENT_KEY = process.env.LPAGENT_API_KEY ?? "";

// ─── Persistence ─────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(SMART_WALLETS_FILE)) return JSON.parse(fs.readFileSync(SMART_WALLETS_FILE, "utf-8"));
  } catch {}
  return { wallets: [], poolSnapshots: {}, lastUpdated: null };
}

function save(data) {
  try {
    fs.mkdirSync(path.dirname(SMART_WALLETS_FILE), { recursive: true });
    fs.writeFileSync(SMART_WALLETS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error("[smartWallets] Save error:", e.message); }
}

// ─── LPAgent API ─────────────────────────────────────────────────────

async function lpagentFetch(endpoint) {
  if (!LPAGENT_KEY) {
    console.warn("[smartWallets] No LPAGENT_API_KEY set");
    return null;
  }
  try {
    const res = await fetch(`${LPAGENT_API}${endpoint}`, {
      headers: { "x-api-key": LPAGENT_KEY, "Accept": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.warn(`[smartWallets] LPAgent ${res.status}: ${await res.text().catch(() => "")}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[smartWallets] LPAgent error: ${e.message}`);
    return null;
  }
}

// ─── Core functions ──────────────────────────────────────────────────

/**
 * Fetch top performers for a specific pool from LPAgent
 */
export async function fetchTopLPers(poolAddress) {
  const data = await lpagentFetch(`/lp-positions/top-performers?pool=${poolAddress}`);
  if (!data) return [];

  const performers = data.data ?? data.performers ?? data.results ?? (Array.isArray(data) ? data : []);
  return performers.map(p => ({
    wallet: p.wallet ?? p.address ?? p.owner ?? "?",
    pnl: p.pnl ?? p.total_pnl ?? p.pnl_usd ?? 0,
    pnlPct: p.pnl_pct ?? p.pnl_percent ?? 0,
    fee: p.total_fee ?? p.fee_usd ?? 0,
    positions: p.position_count ?? p.positions ?? 1,
  }));
}

/**
 * Study a pool: fetch top LPers and save to tracked wallets
 */
export async function studyPool(poolAddress) {
  console.log(`[smartWallets] Studying pool ${poolAddress.slice(0, 8)}...`);
  const topLPers = await fetchTopLPers(poolAddress);
  if (topLPers.length === 0) return { added: 0, topLPers: [] };

  const db = load();
  const existing = new Set(db.wallets.map(w => w.address));
  let added = 0;

  for (const lper of topLPers.slice(0, 10)) {
    if (lper.wallet === "?" || existing.has(lper.wallet)) continue;
    db.wallets.push({
      address: lper.wallet,
      label: `TopLP-${poolAddress.slice(0, 6)}`,
      pnl: lper.pnl,
      source: "lpagent",
      addedAt: new Date().toISOString(),
    });
    existing.add(lper.wallet);
    added++;
  }

  // Save pool snapshot
  db.poolSnapshots[poolAddress] = {
    topLPers: topLPers.slice(0, 10),
    fetchedAt: new Date().toISOString(),
  };
  db.lastUpdated = new Date().toISOString();
  save(db);

  console.log(`[smartWallets] Added ${added} wallets from pool ${poolAddress.slice(0, 8)}`);
  return { added, topLPers: topLPers.slice(0, 10) };
}

/**
 * Add a wallet manually
 */
export function addWallet(address, label = "manual") {
  const db = load();
  const exists = db.wallets.find(w => w.address === address);
  if (exists) return { added: false, reason: "already tracked" };

  db.wallets.push({
    address,
    label,
    source: "manual",
    addedAt: new Date().toISOString(),
  });
  save(db);
  return { added: true };
}

/**
 * Get all tracked wallets
 */
export function getTrackedWallets() {
  return load().wallets ?? [];
}

/**
 * Check how many smart wallets have positions in a given pool.
 * Uses LPAgent API to check current positions.
 */
export async function getSmartWalletSignals(poolAddress) {
  const db = load();
  const tracked = db.wallets;
  if (tracked.length === 0) return { count: 0, wallets: [] };

  // Check pool's top performers to see if any tracked wallets are active
  const topLPers = await fetchTopLPers(poolAddress);
  const trackedSet = new Set(tracked.map(w => w.address));
  const matches = topLPers.filter(lp => trackedSet.has(lp.wallet));

  return {
    count: matches.length,
    wallets: matches.map(m => {
      const tracked = db.wallets.find(w => w.address === m.wallet);
      return { address: m.wallet, label: tracked?.label ?? "?", pnl: m.pnl };
    }),
  };
}

/**
 * Check smart wallet overlap for multiple pools.
 * Returns a map: poolAddress → { count, wallets }
 */
export async function checkSmartWalletOverlap(poolAddresses) {
  const results = {};
  // Limit to 5 pools to avoid API rate limits
  for (const addr of poolAddresses.slice(0, 5)) {
    try {
      results[addr] = await getSmartWalletSignals(addr);
      if (poolAddresses.length > 1) await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      results[addr] = { count: 0, wallets: [] };
    }
  }
  return results;
}

/**
 * Refresh: study top pools from recent scans to discover new smart wallets
 */
export async function refreshSmartWallets(poolAddresses) {
  console.log(`[smartWallets] Refreshing from ${poolAddresses.length} pools...`);
  let totalAdded = 0;
  for (const addr of poolAddresses.slice(0, 3)) {
    const { added } = await studyPool(addr);
    totalAdded += added;
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(`[smartWallets] Refresh done: ${totalAdded} new wallets added`);
  return totalAdded;
}

// ─── Telegram formatting ─────────────────────────────────────────────

export function formatWalletsMessage() {
  const db = load();
  const wallets = db.wallets ?? [];
  if (wallets.length === 0) return "<b>📡 Smart Wallets</b>\n\nNo wallets tracked yet.\nUse /studypool &lt;pool_address&gt; to discover top LPers.";

  let msg = `<b>📡 Smart Wallets (${wallets.length})</b>\n${"─".repeat(25)}\n\n`;
  for (const w of wallets.slice(0, 15)) {
    const label = w.label ?? "?";
    const addr = w.address?.slice(0, 8) ?? "?";
    const pnl = typeof w.pnl === "number" ? ` | PnL: $${w.pnl.toFixed(0)}` : "";
    msg += `• <b>${label}</b> <code>${addr}...</code>${pnl}\n`;
  }
  if (wallets.length > 15) msg += `\n<i>... and ${wallets.length - 15} more</i>`;
  if (db.lastUpdated) msg += `\n\n<i>Updated: ${new Date(db.lastUpdated).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}</i>`;
  return msg;
}
