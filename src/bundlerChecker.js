import fetch from "node-fetch";

const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

export async function checkBundler(poolAddress) {
  try {
    const txs = await getRecentTransactions(poolAddress, 20);
    const analysis = analyzeTxs(txs);
    return {
      safe: analysis.riskScore < 70,
      reason: analysis.reason,
      riskScore: analysis.riskScore,
    };
  } catch (err) {
    return { safe: true, reason: "check failed", riskScore: 30 };
  }
}

async function getRecentTransactions(address, limit = 20) {
  const res = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "getSignaturesForAddress",
      params: [address, { limit }],
    }),
  });
  const json = await res.json();
  return json.result ?? [];
}

function analyzeTxs(txs) {
  if (txs.length === 0) return { riskScore: 40, reason: "no tx history" };
  const blockTimes = txs.map(tx => tx.blockTime).filter(Boolean);
  const uniqueBlocks = new Set(blockTimes).size;
  const clusterRatio = 1 - uniqueBlocks / blockTimes.length;
  const errorCount = txs.filter(tx => tx.err !== null).length;
  const errorRate = errorCount / txs.length;
  let riskScore = 0;
  let reasons = [];
  if (clusterRatio > 0.7) { riskScore += 40; reasons.push("high clustering"); }
  if (errorRate > 0.5) { riskScore += 30; reasons.push("high error rate"); }
  return {
    riskScore: Math.min(riskScore, 100),
    reason: reasons.length ? reasons.join(", ") : "looks clean",
  };
}
