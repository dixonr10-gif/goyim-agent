import { config } from "../config.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

async function fetchWithRetry(body, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${config.openRouterApiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/goyim-agent",
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content;
      if (raw) return raw;
      console.log(`[LLM] Empty response, retry ${i}/${retries}...`);
    } catch (err) {
      console.log(`[LLM] Fetch error attempt ${i}/${retries}:`, err.message);
      if (i === retries) throw err;
    }
    await new Promise(r => setTimeout(r, 2000 * i));
  }
  throw new Error("LLM returned empty response after retries");
}

// Generic chat call for ad-hoc LLM decisions (Part 19 smart rebalance, etc.)
// Thin wrapper over fetchWithRetry — returns raw text so callers parse their
// own response shape. Defaults to smart-tier model; pass modelKey "fast" to
// use haiku-4.5 instead.
export async function callLLMChat({ system, user, modelKey = "smart", temperature = 0.2, maxTokens = 400 } = {}) {
  const model = modelKey === "fast" ? config.openRouterModelFast : config.openRouterModelSmart;
  return await fetchWithRetry({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature,
    max_tokens: maxTokens,
  });
}

export async function agentDecide({ pools, poolAnalyses = [], openPositions, tradeMemoryContext = "", lessonsContext = "", patternsContext = "", brainContext = "" }) {
  const systemPrompt = buildSystemPrompt(brainContext);
  const userPrompt = buildUserPrompt({ pools, poolAnalyses, openPositions, tradeMemoryContext, lessonsContext, patternsContext });

  console.log("🧠 Asking LLM for decision...");

  const raw = await fetchWithRetry({
    model: config.openRouterModelSmart,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });

  try {
    // Strip markdown fences and whitespace before parsing
    let cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found");
    return JSON.parse(match[0]);
  } catch {
    console.log(`[LLM] JSON parse failed, defaulting to skip. Raw: ${raw.slice(0, 120)}`);
    return { action: "skip", targetPool: null, strategy: "spot", confidence: 0, rationale: "LLM response not parseable" };
  }
}

export async function generateLossReview(trade, brainContext = "") {
  console.log("🔴 Generating loss review...");
  const prompt = `You just took a LOSS on this trade:
Pool: ${trade.poolName}
Strategy: ${trade.strategy}
P&L: ${trade.pnlPercent}%
Hold duration: ${trade.holdDurationHours}h

Current brain rules:
${brainContext}

Analyze what went wrong. Respond in JSON:
{
  "mistake": "<what went wrong>",
  "newRule": "<new rule to avoid this>",
  "removeRule": "<rule number to remove or null>",
  "adjustment": "<what to do differently>"
}`;

  const raw = await fetchWithRetry({
    model: config.openRouterModelSmart,
    messages: [
      { role: "system", content: "You are Goyim, aggressive Solana DeFi trading agent. Learn from every loss." },
      { role: "user", content: prompt },
    ],
    temperature: 0.5,
    max_tokens: 400,
  });

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch { return null; }
}

function buildSystemPrompt(brainContext) {
  return `You are Goyim, an aggressive Solana DeFi trading agent specializing in DLMM liquidity provision on Meteora.

SOLANA MEME TOKEN REALITY (2026 DATA):
- 90% of new Solana meme tokens DIE within 12 hours (rug, honeypot, dev dump)
- 8% die within 12–48 hours (momentum exhaustion, liquidity pull)
- 2% survive to 1 week
- Only 1% ever return to their ATH

AGE TIER (informational descriptor — pre-applied as score modifier):
- YOLO_<12h: very fresh token. Score modifier: -10. Historical survival ~10%.
- DANGER_12-24h: post-launch but pre-survival. Score modifier: -5. Mixed outcomes.
- CAUTION_24-48h: mid-life pool. Score modifier: 0 (neutral).
- MATURE_>48h: survivor candidate. Score modifier: +5. Better baseline odds.
- UNKNOWN: data unavailable from DexScreener and Helius. Score modifier: -10. Cannot verify age.

The score modifier is already baked into the finalScore you receive. Use the tier as one of several signals (alongside fee/TVL, organic, OHLCV pattern, drain). No tier auto-blocks entry — evaluate the total picture.

Your default bias should be SKEPTICAL, NOT OPTIMISTIC. When in doubt, SKIP. Forcing entry at high risk = gambling, not trading.

HOWEVER: Balance skepticism with opportunity recognition. When strong quality signals align (organicScore ≥65, bidask strategy, non-DUMPING pattern, fee APR ≥30%), take calculated risks. Skipping too conservatively on genuinely qualified candidates = missing opportunities. Target: 2-5 quality entries per active session, not 0.

TVL DRAIN TRAP (tvlDrainReason field): when a pool's TVL is dropping faster than fees decay, the Fee/TVL ratio MECHANICALLY RISES as LPs exit. A "hotter" pool on this metric that also carries a tvlDrainReason is a DYING pool, not an opportunity. Treat any TVL DRAIN ≥30% (MEDIUM) as a strong negative; ≥50% (HIGH) or ≥70% (CRITICAL) should override even attractive APR and age tier.

MINDSET: High risk, high reward DEGEN. But smart degen — APE early, not late. Your goal is to earn fees AND profit from momentum, but timing is everything.

SCORING GUIDANCE:
- Early pump + high fee/TVL = BEST entry, prioritize these
- Late pump (>50% in 6h) = only enter if fee/TVL >100%, otherwise skip
- Sells > buys = reevaluate: if organicScore high and volume consistent → enter. If organicScore low → skip
- High fee/TVL (>80%) = strong green light regardless of momentum
- New token (1-30 days) with accelerating volume = high priority

STRICTLY FORBIDDEN - NEVER open positions on:
- Any pool containing stablecoins (USDC, USDT, DAI, BUSD, USDS, USDH)
- JUP-SOL, JupSOL-SOL, WBTC-JLP, or any JLP/LP token pool
- Any token with market cap > $200M (large-cap, not meme)
- SOL paired with stablecoins in any direction

ONLY open positions on:
- Meme token pools: market cap $100K-$200M
- New/trending tokens: 1 hour to 30 days old
- Volume 24h: $100K-$15M
- Pool liquidity: $15K-$1M
- Organic score: high (not wash-traded)
- Fee/TVL: Prefer pools above 30% 24h fee/TVL. 15-30% fee/TVL acceptable if strong fundamentals (organicScore ≥70, accumulating or stable pattern, clean volume trajectory).

If no qualifying pools exist, respond with action: skip.

${brainContext ? brainContext + "\n\n" : ""}CHART ANALYSIS is provided for each pool. Use it as a key factor:
- EARLY_PUMP + INCREASING volume = strong entry signal
- PUMP_EXHAUSTION or DUMPING = avoid unless fee/TVL > 150%
- ACCUMULATING = good entry
- Always consider chart pattern alongside fee/TVL and score

CRITICAL RULES FOR JSON RESPONSE:
- "action": must be exactly "open", "close", "hold", or "skip"
- "targetPool": must be the FULL 44-CHARACTER BASE58 ADDRESS (e.g. "87ESAEYJKYpARBUeUioNjgadn9K4KhzoqJ95oN53oYkJ")
- NEVER put pool name (like "PIXEL-SOL") in targetPool field
- ALWAYS copy the ADDRESS field exactly from the pool list

Respond ONLY in this JSON format:
{
  "action": "open",
  "targetPool": "<FULL_44_CHAR_ADDRESS_HERE>",
  "strategy": "spot",
  "confidence": 75,
  "opportunityScore": 80,
  "rationale": "brief explanation",
  "rulesUsed": [1, 2]
}`;
}

function buildUserPrompt({ pools, poolAnalyses, openPositions, tradeMemoryContext, lessonsContext, patternsContext }) {
  const poolList = pools.map((p, i) => {
    const a = poolAnalyses[i] ?? {};
    const ageStr = typeof p.tokenAgeHours === "number"
      ? `${p.tokenAgeHours}h (${p.tokenAgeTier})`
      : `unknown (${p.tokenAgeTier ?? "UNKNOWN"})`;
    let line = `[${i+1}] NAME: ${p.name}
    ADDRESS: ${p.address}
    score=${a.opportunityScore ?? "?"} | vol=${a.volatility?.level ?? "?"} | trend=${a.trend?.direction ?? "?"} | apr=${p.feeApr}% | tvl=$${p.tvl} | uptrend=${p.uptrend ?? false} (bonus only, NOT required)
    tokenAge=${ageStr}`;
    if (p.tvlDrainReason) {
      line += `\n    ⚠️ TVL DRAIN: ${p.tvlDrainReason} [${p.tvlDrainSeverity}] — LPs are exiting, high Fee/TVL here is death not opportunity`;
    }
    if (p.ta && p.ta.rsi !== null) {
      const rsiLabel = p.ta.rsi > 70 ? "overbought" : p.ta.rsi < 30 ? "oversold" : "neutral";
      const emaDir = p.ta.currentPrice >= p.ta.ema20 ? "above" : "below";
      const emaPct = p.ta.ema20 > 0 ? (((p.ta.currentPrice - p.ta.ema20) / p.ta.ema20) * 100).toFixed(1) : "0";
      line += `\n    TA: RSI ${p.ta.rsi.toFixed(1)} (${rsiLabel}) | Price vs EMA20: ${emaDir} (${emaPct}%) | Signal: ${p.ta.signal}`;
    }
    if (p.chart) {
      line += `\n    CHART ANALYSIS (5m candles):`;
      line += `\n    - Price trend: ${p.chart.priceTrend}`;
      line += `\n    - Volume trend: ${p.chart.volumeTrend}`;
      line += `\n    - Pattern: ${p.chart.pattern}`;
      line += `\n    - Last 3 candles: ${p.chart.last3Candles}`;
      if (p.chart.pattern === "POST_DUMP_TRAP") {
        const h24Str = (typeof p.chart.h24 === "number") ? p.chart.h24.toFixed(1) : "?";
        const h6Str = (typeof p.chart.h6 === "number") ? p.chart.h6.toFixed(1) : "?";
        line += `\n    ⚠️ POST_DUMP_TRAP DETECTED: Token shows post-rug flatline, NOT accumulation phase. Price dumped ${h24Str}% in 24h and still bleeding (${h6Str}% in 6h). Volume on dead pool ≠ recovery signal. Catastrophic loss risk. STRONGLY skeptical default — require exceptional evidence to enter.`;
      }
    }
    if (p.cumDrainCount && p.cumDrainCount >= 5) {
      line += `\n    ⚠️ CUMULATIVE DRAIN HISTORY: Pool has ${p.cumDrainCount} TVL drain events in last 7 days (tier ${p.cumDrainTier}). Repeated liquidity instability — high reserve recommended.`;
    }
    return line;
  }).join("\n\n");

  return `=== AVAILABLE POOLS (${pools.length}) ===
${poolList || "None"}

=== OPEN POSITIONS (${openPositions.length}/${config.maxOpenPositions ?? 6}) ===
${openPositions.map(p => `- ${p.pool?.slice(0,8)}... | ${p.strategy} | ${p.solDeployed} SOL`).join("\n") || "None"}

=== TRADE MEMORY ===
${tradeMemoryContext || "No history yet"}

=== LESSONS (learn from these!) ===
${lessonsContext || "No lessons yet"}

=== PATTERNS ===
${patternsContext || "No patterns yet"}

INSTRUCTION: When action is "open", copy the ADDRESS field EXACTLY into targetPool.
Example: if pool shows "ADDRESS: 87ESAEYJKYpARBUeUioNjgadn9K4KhzoqJ95oN53oYkJ", then targetPool = "87ESAEYJKYpARBUeUioNjgadn9K4KhzoqJ95oN53oYkJ"

Respond ONLY with valid JSON.`;
}
