import { config } from "../config.js";

export async function getWalletAddress() {
  const bs58 = await import("bs58");
  const { Keypair } = await import("@solana/web3.js");
  const wallet = Keypair.fromSecretKey(bs58.default.decode(config.walletPrivateKey));
  return wallet.publicKey.toString();
}

export async function getSOLBalance(walletAddress) {
  const res = await fetch(config.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [walletAddress] }),
  });
  const data = await res.json();
  return (data?.result?.value ?? 0) / 1e9;
}

export async function getTokenBalances(walletAddress) {
  try {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getTokenAccountsByOwner",
        params: [walletAddress, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }],
      }),
    });
    const data = await res.json();
    return (data?.result?.value ?? [])
      .map(acc => ({ mint: acc.account.data.parsed.info.mint, amount: acc.account.data.parsed.info.tokenAmount.uiAmount }))
      .filter(t => t.amount > 0);
  } catch { return []; }
}

export function formatWalletMessage(address, solBalance, tokenBalances) {
  let msg = "<b>👛 Wallet Agent</b>\n";
  msg += `<code>${address}</code>\n\n`;
  msg += `<b>💰 SOL:</b> <b>${solBalance?.toFixed(4) ?? "?"} SOL</b>\n`;
  msg += `≈ $${((solBalance ?? 0) * 150).toFixed(2)} USD\n`;
  if (tokenBalances.length > 0) {
    msg += `\n<b>🪙 Tokens (${tokenBalances.length}):</b>\n`;
    tokenBalances.slice(0, 5).forEach(t => {
      msg += `• <code>${t.mint.slice(0, 8)}...</code>: ${t.amount?.toFixed(4)}\n`;
    });
  }
  return msg;
}

export function formatPnLMessage(stats, positions) {
  const s = stats?.stats ?? {};
  let msg = "<b>📈 P&L Summary</b>\n";
  msg += `Total: <b>${s.totalPnlSol ?? 0} SOL</b>\n`;
  msg += `Win rate: <b>${s.hitRate ?? 0}%</b>\n`;
  return msg;
}

