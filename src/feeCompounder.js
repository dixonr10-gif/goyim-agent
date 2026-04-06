import { createRequire } from "module";
import { config } from "../config.js";

const require = createRequire(import.meta.url);
let _compoundInterval = null;

async function getWallet() {
  const { Keypair } = require("@solana/web3.js");
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const key = config.walletPrivateKey.trim();
  let result = BigInt(0);
  for (const char of key) { result = result * 58n + BigInt(ALPHABET.indexOf(char)); }
  const hex = result.toString(16).padStart(128, "0");
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bytes[i] = parseInt(hex.slice(i*2, i*2+2), 16);
  return Keypair.fromSecretKey(bytes);
}

function getConnection() {
  const { Connection } = require("@solana/web3.js");
  return new Connection(config.rpcUrl, { commitment: "confirmed" });
}

export async function claimAndCompoundFees(openPositions) {
  if (!openPositions || openPositions.length === 0) return;

  console.log("💰 Checking fees to compound...");
  const DLMM = require("@meteora-ag/dlmm");
  const DLMMClass = DLMM.default ?? DLMM;
  const { PublicKey, sendAndConfirmTransaction } = require("@solana/web3.js");

  const wallet = await getWallet();
  const connection = getConnection();

  let totalClaimed = 0;

  for (const pos of openPositions) {
    if (pos.mock || !pos.pool || !pos.positionAddress) continue;

    try {
      const dlmmPool = await DLMMClass.create(connection, new PublicKey(pos.pool));
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(wallet.publicKey);
      const positionData = userPositions.find(p => p.publicKey.toString() === pos.positionAddress);

      if (!positionData) continue;

      // Cek apakah ada fee yang bisa di-claim
      const feeX = positionData.positionData.feeX?.toNumber() ?? 0;
      const feeY = positionData.positionData.feeY?.toNumber() ?? 0;

      if (feeX === 0 && feeY === 0) {
        console.log(`  💤 ${pos.pool?.slice(0,8)}...: no fees yet`);
        continue;
      }

      console.log(`  💰 ${pos.pool?.slice(0,8)}...: claiming feeX=${feeX} feeY=${feeY}`);

      // Claim fees
      const claimTx = await dlmmPool.claimAllFee({
        owner: wallet.publicKey,
        positions: [positionData],
      });

      const sig = await sendAndConfirmTransaction(connection, claimTx, [wallet]);
      console.log(`  ✅ Fees claimed: https://solscan.io/tx/${sig}`);
      totalClaimed++;

    } catch (err) {
      console.error(`  ❌ Compound error ${pos.pool?.slice(0,8)}...: ${err.message}`);
    }
  }

  if (totalClaimed > 0) {
    console.log(`✅ Compounded fees dari ${totalClaimed} posisi!`);
  } else {
    console.log("💤 Tidak ada fee untuk di-compound sekarang.");
  }
}

export function startFeeCompounder(getPositionsFn, intervalMinutes = 30) {
  if (_compoundInterval) clearInterval(_compoundInterval);

  console.log(`💰 Fee compounder started — interval ${intervalMinutes} menit`);

  _compoundInterval = setInterval(async () => {
    try {
      const positions = getPositionsFn();
      await claimAndCompoundFees(positions);
    } catch (err) {
      console.error("❌ Fee compounder error:", err.message);
    }
  }, intervalMinutes * 60 * 1000);

  return _compoundInterval;
}

export function stopFeeCompounder() {
  if (_compoundInterval) {
    clearInterval(_compoundInterval);
    _compoundInterval = null;
    console.log("⏹️ Fee compounder stopped.");
  }
}

