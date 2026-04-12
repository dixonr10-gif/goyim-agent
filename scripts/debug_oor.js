const d = require("/root/goyim-agent/data/trade_memory.json");
const c = d.trades.filter(t => t.closedAt);
const total = c.length;
const shortHold = c.filter(t => parseFloat(t.holdDurationHours) < 0.5);
const wins = c.filter(t => t.outcome === "win");
const losses = c.filter(t => t.outcome === "loss");

console.log("=== TRADE STATS ===");
console.log("Total closed:", total, "| Wins:", wins.length, "| Losses:", losses.length);
console.log("Hold < 30min:", shortHold.length, "/", total, "(" + (shortHold.length/total*100).toFixed(0) + "%)");

// Exit reason breakdown
const exits = {};
c.forEach(t => { const r = t.exitReason || "unknown"; exits[r] = (exits[r]||0) + 1; });
console.log("\n=== EXIT REASONS ===");
Object.entries(exits).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(" ", k, ":", v));

// All trades with strategy and bins info
console.log("\n=== ALL TRADES (strategy + bins + exit + hold) ===");
c.forEach(t => {
  const bins = t.binRange;
  const width = bins ? (bins.upper - bins.lower + 1) : "?";
  console.log(
    t.closedAt.slice(0,16),
    (t.poolName || "unknown").padEnd(15),
    "strat:" + (t.strategy || "spot").padEnd(7),
    "exit:" + (t.exitReason || "?").padEnd(12),
    "pnl:" + String(t.pnlPercent||0).slice(0,6).padEnd(7) + "%",
    "hold:" + String(t.holdDurationHours||"?").padEnd(5) + "h",
    "width:" + String(width).padEnd(4),
    "bins:" + JSON.stringify(bins||{})
  );
});

// Focus on OOR patterns
console.log("\n=== SHORT HOLD (<30min) DETAIL ===");
shortHold.forEach(t => {
  console.log(
    t.closedAt.slice(0,16),
    t.poolName || "unknown",
    "strat:" + (t.strategy || "spot"),
    "pnl:" + t.pnlPercent + "%",
    "hold:" + t.holdDurationHours + "h",
    "exit:" + (t.exitReason || "?"),
    "oorDir:" + (t.oorDirection || "?"),
    "bins:" + JSON.stringify(t.binRange||{})
  );
});
