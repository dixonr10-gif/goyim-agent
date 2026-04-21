// src-vps/tokenAge.js
// Resolve a pool/token's age for Part 17's age filter.
//
// PRIMARY source — DexScreener pairCreatedAt. This is the pool listing time
// on Solana and closely approximates the meme-token creation time. It's the
// single most accurate "is this fresh?" signal we have cheaply.
//
// FALLBACK source — Helius getSignaturesForAddress on the token mint. Sigs
// come back reverse-chronological; if <1000 sigs total, the last one is the
// mint's first tx (= creation). For mints with ≥1000 sigs we short-circuit
// to MATURE_FLOOR_HOURS (30d) — Part 17 only needs four buckets and doesn't
// care about precision past 48h.
//
// Why both, with DexScreener first: a brand-new mint with sniper-bot tx
// storm can cross 1000 sigs in minutes → Helius alone falsely tags it
// MATURE. DexScreener knows when the pool listed and doesn't get fooled by
// transaction volume.
//
// 1h in-memory cache. Keyed on poolAddress (primary) or mint (fallback-only
// path). Returns { ageHours, source } or null on total failure (permissive).
//
// Spec: "Fallback: kalau Helius fail, skip check (permissive)."

import { config } from "../config.js";

const WSOL = "So11111111111111111111111111111111111111112";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const MATURE_FLOOR_HOURS = 24 * 30;  // ≥1000 sigs → "very old" (720h)
const MAX_PLAUSIBLE_HOURS = 24 * 365 * 5; // 5y sanity cap for DexScreener values
const RPC_TIMEOUT_MS = 10_000;
const DEX_TIMEOUT_MS = 5_000;

const _cache = new Map(); // key → { ageHours, source, fetchedAt }

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

// Classify hours → Part 17 tier. Returns null on null input.
export function classifyAgeTier(hours) {
  if (typeof hours !== "number" || !Number.isFinite(hours)) return null;
  if (hours < 12) return "YOLO_<12h";
  if (hours < 24) return "DANGER_12-24h";
  if (hours < 48) return "CAUTION_24-48h";
  return "MATURE_>48h";
}

// ── DexScreener (primary) ────────────────────────────────────────────────
async function fetchPairCreatedAtMs(poolAddress) {
  if (!poolAddress) return null;
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DEX_TIMEOUT_MS),
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pairCreatedAt = data?.pair?.pairCreatedAt ?? data?.pairs?.[0]?.pairCreatedAt ?? null;
    return (typeof pairCreatedAt === "number" && Number.isFinite(pairCreatedAt) && pairCreatedAt > 0)
      ? pairCreatedAt
      : null;
  } catch (err) {
    console.warn(`[TokenAge] DexScreener pair fetch failed for ${poolAddress.slice(0, 8)}...: ${err.message}`);
    return null;
  }
}

// ── Helius (fallback) ────────────────────────────────────────────────────
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

async function getHeliusBasedAge(mint) {
  if (!mint || typeof mint !== "string") return null;
  if (mint === WSOL) return { ageHours: MATURE_FLOOR_HOURS, source: "wsol" };
  try {
    const sigs = await rpcCall("getSignaturesForAddress", [mint, { limit: 1000 }]);
    if (!Array.isArray(sigs) || sigs.length === 0) return null;
    if (sigs.length >= 1000) {
      // Sig-cap fallback — imprecise but bucketed correctly for "old" tokens.
      // Known false-positive case: brand-new meme with sniper tx storm. That's
      // why DexScreener is the primary — this path should only fire when the
      // primary is unavailable.
      return { ageHours: MATURE_FLOOR_HOURS, source: "helius_signature_cap" };
    }
    const oldest = sigs[sigs.length - 1];
    const blockTime = oldest?.blockTime;
    if (typeof blockTime !== "number" || blockTime <= 0) return null;
    return { ageHours: (Date.now() / 1000 - blockTime) / 3600, source: "helius_signature" };
  } catch (err) {
    console.warn(`[TokenAge] ${mint.slice(0, 8)}... Helius error: ${err.message}`);
    return null;
  }
}

// ── Public entry: primary → fallback, cache both ─────────────────────────
export async function getTokenAgeHours(mint, poolAddress = null) {
  const cacheKey = poolAddress || mint;
  if (!cacheKey) return null;

  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ageHours: cached.ageHours, source: cached.source };
  }

  // Primary: DexScreener pairCreatedAt
  if (poolAddress) {
    const pairCreatedAt = await fetchPairCreatedAtMs(poolAddress);
    if (pairCreatedAt) {
      const ageHours = (Date.now() - pairCreatedAt) / 3_600_000;
      if (ageHours >= 0 && ageHours < MAX_PLAUSIBLE_HOURS) {
        const result = { ageHours, source: "dexscreener_pair" };
        _cache.set(cacheKey, { ...result, fetchedAt: Date.now() });
        return result;
      }
    }
  }

  // Fallback: Helius signature-based age on the mint.
  const fallback = await getHeliusBasedAge(mint);
  if (fallback) {
    _cache.set(cacheKey, { ...fallback, fetchedAt: Date.now() });
  }
  return fallback;
}
