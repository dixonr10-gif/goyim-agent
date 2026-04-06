// scripts/seedPositions.js
// Run once to populate open_positions.json from on-chain wallet state
// Usage: node scripts/seedPositions.js

import { createRequire } from "module";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const require = createRequire(import.meta.url);
const POSITIONS_FILE = path.resolve("data/open_positions.json");
const MAX_SOL = Number(process.env.MAX_SOL_PER_POSITION) || 0.5;

function loadPositions() {
  try {
    if (fs.existsSync(POSITIONS_FILE)) return JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf-8"));
  } catch {}
  return {};
}

async function getWallet() {
  const { Keypair } = require("@solana/web3.js");
  const key = process.env.WALLET_PRIVATE_KEY?.trim();
  if (!key) throw new Error("WALLET_PRIVATE_KEY not set in .env");
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let result = BigInt(0);
  for (const char of key) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) throw new Error(`Invalid base58 char: ${char}`);
    result = result * 58n + BigInt(idx);
  }
  const hex = result.toString(16).padStart(128, "0");
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return Keypair.fromSecretKey(bytes);
}

async function main() {
  console.log("🔍 Fetching all positions from on-chain...");
  const DLMM = require("@meteora-ag/dlmm");
  const DLMMClass = DLMM.default ?? DLMM;
  const { Connection } = require("@solana/web3.js");

  const connection = new Connection(process.env.RPC_URL || "https://api.mainnet-beta.solana.com", { commitment: "confirmed" });
  const wallet = await getWallet();
  console.log("Wallet:", wallet.publicKey.toString());

  const allPositions = await DLMMClass.getAllLbPairPositionsByUser(connection, wallet.publicKey);

  const entries = allPositions instanceof Map
    ? [...allPositions.entries()]
    : Object.entries(allPositions ?? {});

  console.log(`Found ${entries.length} LB pair(s) with positions`);

  const existing = loadPositions();
  const existingAddresses = new Set(
    Object.values(existing).filter(p => p.positionAddress).map(p => p.positionAddress)
  );

  let added = 0;
  for (const [lbPair, pairData] of entries) {
    for (const pos of pairData.lbPairPositionsData ?? []) {
      const posAddress = pos.publicKey?.toString();
      if (!posAddress) continue;

      if (existingAddresses.has(posAddress)) {
        console.log(`  ⏭️  Already tracked: ${posAddress.slice(0, 8)}...`);
        continue;
      }

      const binData = pos.positionData?.positionBinData ?? [];
      const binIds = binData.map(b => b.binId).filter(Number.isFinite);
      const binRange = binIds.length > 0
        ? { lower: Math.min(...binIds), upper: Math.max(...binIds) }
        : undefined;

      existing[posAddress] = {
        id: posAddress,
        pool: lbPair,
        positionAddress: posAddress,
        strategy: "spot",
        solDeployed: MAX_SOL,
        openedAt: new Date().toISOString(),
        binRange,
        syncedFromChain: true,
        recoveredAt: new Date().toISOString(),
      };

      console.log(`  ✅ Added: ${posAddress.slice(0, 8)}... pool: ${lbPair.slice(0, 8)}...`);
      added++;
    }
  }

  fs.mkdirSync(path.dirname(POSITIONS_FILE), { recursive: true });
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(existing, null, 2));
  console.log(`\n✅ Done. Added ${added} new position(s). Total: ${Object.keys(existing).length}`);
  console.log("Now restart the agent — stop loss will evaluate on the next loop.");
}

main().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});
