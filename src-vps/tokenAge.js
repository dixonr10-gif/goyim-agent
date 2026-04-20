// src-vps/tokenAge.js
// Resolve a token mint's on-chain creation age via the Helius-powered RPC.
//
// Strategy: `getSignaturesForAddress(mint, { limit: 1000 })` returns sigs in
// reverse-chronological order. If the result has fewer than 1000 entries, the
// last one is the mint's first tx (= its creation). For tokens with >1000 txs
// we short-circuit to "mature" (> MATURE_FLOOR_HOURS) since Part 17 only cares
// about four age buckets — we never need a precise number beyond 48h.
//
// In-memory cache with a 1h TTL — token age changes only forward, so a stale
// entry under-reports age at worst, never blocks a valid candidate.
//
// Returns null on any Helius failure so the caller can apply a permissive
// skip (Part 17 spec: "Fallback: kalau Helius fail, skip check (permissive)").

import { config } from "../config.js";

const WSOL = "So11111111111111111111111111111111111111112";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const MATURE_FLOOR_HOURS = 24 * 30;  // ≥1000 sigs → treat as "very old" (720h)
const RPC_TIMEOUT_MS = 10_000;

const _cache = new Map(); // mint → { ageHours, fetchedAt }

function getRpcUrl() {
  return config.rpcUrl || process.env.RPC_URL || null;
}

// Extract the non-SOL token mint from a pool object. Prefers Meteora datapi
// fields (stable) over DexScreener (sometimes misses the quote side).
export function extractTokenMint(pool) {
  const candidates = [
    pool?.mint_x,
    pool?.mint_y,
    pool?.dexPair?.baseToken?.address,
    pool?.dexPair?.quoteToken?.address,
  ].filter(m => typeof m === "string" && m.length >= 32 && m.length <= 44);
  for (const m of candidates) {
    if (m !== WSOL) return m;
  }
  return null;
}

export function clearTokenAgeCache() { _cache.clear(); }

async function rpcCall(method, params) {
  const url = getRpcUrl();
  if (!url) throw new Error("no RPC_URL");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error?.message ?? JSON.stringify(json.error)}`);
  return json.result;
}

export async function getTokenAgeHours(mint) {
  if (!mint || typeof mint !== "string") return null;
  if (mint === WSOL) return MATURE_FLOOR_HOURS; // SOL itself is ancient

  const cached = _cache.get(mint);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.ageHours;
  }

  try {
    const sigs = await rpcCall("getSignaturesForAddress", [mint, { limit: 1000 }]);
    if (!Array.isArray(sigs)) return null;
    if (sigs.length === 0) return null; // account exists but no history (permissive)

    let ageHours;
    if (sigs.length >= 1000) {
      // Capped — mint has >1000 txs. We don't need precision past 48h for
      // Part 17's buckets, so flag as "very old" and cache for the TTL.
      ageHours = MATURE_FLOOR_HOURS;
    } else {
      const oldest = sigs[sigs.length - 1];
      const blockTime = oldest?.blockTime;
      if (typeof blockTime !== "number" || blockTime <= 0) return null;
      ageHours = (Date.now() / 1000 - blockTime) / 3600;
    }

    _cache.set(mint, { ageHours, fetchedAt: Date.now() });
    return ageHours;
  } catch (err) {
    console.warn(`[TokenAge] ${mint.slice(0, 8)}... Helius error: ${err.message}`);
    return null; // permissive: caller treats null as "unknown, don't block"
  }
}

// Classify hours → Part 17 tier. Returns null on null input.
export function classifyAgeTier(hours) {
  if (typeof hours !== "number" || !Number.isFinite(hours)) return null;
  if (hours < 12) return "YOLO_<12h";
  if (hours < 24) return "DANGER_12-24h";
  if (hours < 48) return "CAUTION_24-48h";
  return "MATURE_>48h";
}
