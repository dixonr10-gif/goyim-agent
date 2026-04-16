import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const WALLET = '8uGZkrvfRJZWFVYXCCFc9WnGGU13McrWNwiU26QCWk4U';
const rpcKey = (process.env.RPC_URL || '').match(/api-key=([^&]+)/);
const KEY = process.env.HELIUS_API_KEY || (rpcKey ? rpcKey[1] : null);
if (!KEY) { console.log('HELIUS_API_KEY not found'); process.exit(1); }

const url = 'https://api.helius.xyz/v0/addresses/' + WALLET + '/transactions?api-key=' + KEY + '&limit=50';
const res = await fetch(url);
if (!res.ok) { console.log('HTTP', res.status, await res.text()); process.exit(1); }
const txs = await res.json();
if (!Array.isArray(txs)) { console.log('Unexpected response:', JSON.stringify(txs).slice(0, 200)); process.exit(1); }

let solIn = 0, solOut = 0, fees = 0, failed = 0;
const types = {};
const big = [];
for (const t of txs) {
  fees += (t.fee || 0) / 1e9;
  if (t.transactionError) failed++;
  const type = t.type || 'UNKNOWN';
  types[type] = (types[type] || 0) + 1;
  for (const nt of (t.nativeTransfers || [])) {
    const amt = (nt.amount || 0) / 1e9;
    if (nt.toUserAccount === WALLET) solIn += amt;
    if (nt.fromUserAccount === WALLET) solOut += amt;
    if (amt >= 1) big.push({ sig: t.signature.slice(0, 12), type, amt: (nt.toUserAccount === WALLET ? '+' : '-') + amt.toFixed(4), from: (nt.fromUserAccount || '').slice(0, 8), to: (nt.toUserAccount || '').slice(0, 8), time: new Date((t.timestamp || 0) * 1000).toISOString().slice(0, 16) });
  }
}

console.log('=== Helius tx summary (last ' + txs.length + ' txs) ===');
console.log('SOL in   :', solIn.toFixed(4));
console.log('SOL out  :', solOut.toFixed(4));
console.log('Net      :', (solIn - solOut).toFixed(4));
console.log('Fees paid:', fees.toFixed(6));
console.log('Failed   :', failed);
console.log();
console.log('By type:');
Object.entries(types).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(' ', v, k));
console.log();
console.log('Large moves (>=1 SOL, first 20):');
big.slice(0, 20).forEach(b => console.log(' ', b.time, b.type.padEnd(18), b.amt.padStart(10), 'from', b.from, 'to', b.to, '(' + b.sig + ')'));

const { Connection, PublicKey } = await import('@solana/web3.js');
const connection = new Connection(process.env.RPC_URL, 'confirmed');
const resp = await connection.getParsedTokenAccountsByOwner(new PublicKey(WALLET), { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
const nonZero = resp.value.map(a => a.account.data.parsed.info).filter(i => i.tokenAmount.uiAmount > 0);
console.log();
console.log('SPL tokens left in wallet (non-zero):', nonZero.length);
nonZero.forEach(i => console.log(' ', i.mint.slice(0, 12) + '...', 'amount=', i.tokenAmount.uiAmount));

const tm = JSON.parse(fs.readFileSync('./data/trade_memory.json', 'utf8'));
const trades = tm.trades || [];
const closedDep = trades.filter(t => t.closedAt).reduce((s, t) => s + (t.solDeployed || 0), 0);
const returned = trades.filter(t => t.closedAt).reduce((s, t) => s + (t.solReturned || 0), 0);
const openDep = trades.filter(t => !t.closedAt).reduce((s, t) => s + (t.solDeployed || 0), 0);
console.log();
console.log('=== trade_memory.json ===');
console.log('Total trades:', trades.length, '| Closed:', trades.filter(t => t.closedAt).length, '| Open:', trades.filter(t => !t.closedAt).length);
console.log('SOL deployed (closed):', closedDep.toFixed(2));
console.log('SOL returned (closed):', returned.toFixed(2));
console.log('Net PnL SOL (closed):', (returned - closedDep).toFixed(3));
console.log('Open capital deployed:', openDep.toFixed(2));
