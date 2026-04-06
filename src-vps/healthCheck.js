// src/healthCheck.js — Hourly health check, alerts on failures only

import fs from "fs";
import path from "path";
import { config } from "../config.js";

const LAST_RUN_FILE = path.resolve("data/lastRun.json");
const HEALER_STALE_MINUTES = 5;
const MIN_SOL_BALANCE = 0.5;

// ─── Record last run timestamps ──────────────────────────────────────

export function recordLastRun(agent) {
  try {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(LAST_RUN_FILE, "utf-8")); } catch {}
    data[agent] = new Date().toISOString();
    fs.mkdirSync(path.dirname(LAST_RUN_FILE), { recursive: true });
    fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.warn("[healthCheck] recordLastRun error:", e.message); }
}

// ─── Health check (runs hourly) ──────────────────────────────────────

export async function runHealthCheck(notifyFn) {
  const issues = [];

  // 1. Check healer freshness
  try {
    const data = JSON.parse(fs.readFileSync(LAST_RUN_FILE, "utf-8"));
    const healerLast = data.healer ? new Date(data.healer) : null;
    const hunterLast = data.hunter ? new Date(data.hunter) : null;

    if (healerLast) {
      const minAgo = (Date.now() - healerLast.getTime()) / 60_000;
      if (minAgo > HEALER_STALE_MINUTES) {
        issues.push(`Healer last run: ${minAgo.toFixed(0)}m ago (STALE)`);
      }
    } else {
      issues.push("Healer: never ran");
    }

    if (hunterLast) {
      const minAgo = (Date.now() - hunterLast.getTime()) / 60_000;
      if (minAgo > 20) {
        issues.push(`Hunter last run: ${minAgo.toFixed(0)}m ago (STALE)`);
      }
    }
  } catch {
    issues.push("lastRun.json not found");
  }

  // 2. Check SOL balance
  try {
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const conn = new Connection(config.rpcUrl, { commitment: "confirmed" });
    const { getWallet } = await import("./positionManager.js");
    const wallet = await getWallet();
    const balance = await conn.getBalance(wallet.publicKey);
    const sol = balance / 1e9;
    if (sol < MIN_SOL_BALANCE) {
      issues.push(`SOL balance: ${sol.toFixed(4)} SOL (LOW < ${MIN_SOL_BALANCE})`);
    }
  } catch (e) {
    issues.push(`Balance check failed: ${e.message.slice(0, 50)}`);
  }

  // 3. Check RPC connectivity
  try {
    const { Connection } = await import("@solana/web3.js");
    const conn = new Connection(config.rpcUrl, { commitment: "confirmed" });
    const slot = await conn.getSlot();
    if (!slot || slot <= 0) {
      issues.push("RPC: getSlot returned invalid");
    }
  } catch (e) {
    issues.push(`RPC down: ${e.message.slice(0, 50)}`);
  }

  // Alert only if issues found
  if (issues.length > 0) {
    const msg = `⚠️ <b>Health Check Failed</b>\n\n${issues.map(i => `• ${i}`).join("\n")}`;
    console.warn("[healthCheck]", issues.join(" | "));
    if (notifyFn) await notifyFn(msg);
  } else {
    console.log("[healthCheck] All OK");
  }

  return issues;
}
