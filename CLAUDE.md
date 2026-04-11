# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Goyim** is an AI-powered autonomous trading agent for Meteora DLMM (Dynamic Liquidity Market Maker) liquidity provision on Solana. It runs two parallel agents that scan pools, analyze markets, make LLM-driven decisions, execute on-chain transactions, and self-improve from trade history.

## Commands

```bash
# Install dependencies
npm install

# Run the agent
npm start          # production
npm run dev        # development (same as start)

# Deploy to VPS
node scripts/deploy.cjs
```

**Environment setup:**
```bash
cp .env.example .env
# Required: RPC_URL, WALLET_PRIVATE_KEY, OPENROUTER_API_KEY
# Optional: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
```

## Architecture

### Dual-Agent Design (`index.js` as orchestrator)

Two agents run independently in parallel:

**Hunter Agent** (`src/hunterAgent.js`) — every `LOOP_INTERVAL_MS` (default 20min):
1. **Learn** — update brain every 6h, discover patterns every 5 trades
2. **Scan** — fetch top Meteora pools (5 pages × 50), enrich with DexScreener multi-timeframe volume
3. **Filter** — volume/TVL/APR/age/organicScore/maxTvl + MEV/bundler risk check
4. **Analyze** — score opportunities 0–100 via volatility, trend, fee momentum
5. **LLM decision** — send full context to OpenRouter; parse JSON with action/confidence/strategy
6. **Execute open** — open DLMM positions on-chain if `confidence ≥ 60` and balance sufficient

**Healer Agent** (`src/healerAgent.js`) — every 10min:
1. **Sync** — sync on-chain positions
2. **Exit evaluation** — OOR grace (30min), fee take-profit, stop-loss, take-profit, max hold, fee APR floor
3. **Execute close** — close triggered positions, record trade, evolve thresholds, post-trade analysis

### Pool Filtering (poolScanner.js)
Pre-filter: vol > $50k, tvl > $5k, APR > 10%, age 5min–7days, not stablecoin-only
Post-enrich filters:
- `maxTvlUsd` (default $150k): reject oversaturated pools
- `minOrganicScore` (default 65/100): reject wash-traded/bot-spike pools
  Score formula: vol/TVL ratio + multi-timeframe consistency + txn count distribution

### Exit Rules (exitStrategy.js)
In priority order:
1. **OOR**: out-of-range → stamp `oorSince`, auto-close after 30min grace
2. **Fee TP**: claimable fees ≥ 15% of deployed SOL → close
3. **Stop Loss**: PnL ≤ `STOP_LOSS_PERCENT` (default -3%)
4. **Take Profit**: PnL ≥ `TAKE_PROFIT_PERCENT` (default +5%)
5. **Max Hold**: position age ≥ `MAX_HOLD_HOURS` (default 48h)
6. **Fee APR floor**: pool fee APR < `MIN_FEE_APR_TO_HOLD` (default 10%)

### Self-Learning System
Two feedback loops run in Hunter:
- **`postTradeAnalyzer.js`** — LLM debriefs each closed trade → `data/lessons.json`
- **`patternLearner.js`** — discovers winning conditions every 5 trades → `data/patterns.json`
- **`thresholdEvolver.js`** — auto-adjusts .env filter thresholds after each close based on win-rate + avg PnL

> **Removed:** `selfImprovingPrompt.js` was deleted because its evolved `oppScore` thresholds caused brain paralysis (rejecting all valid candidates). `thresholdEvolver` is the safe alternative — it only adjusts pool filter thresholds, not decision logic.

### LP Study (`src/lpStudy.js`)
Fetches top Meteora pools, sends to LLM for 4-8 actionable lessons → `data/lp_lessons.json`.
Triggered via Telegram `/learn [pool_address]` or programmatically.

### State Persistence (`data/`)
- `trade_memory.json` — full trade history, win/loss stats, pool blacklist/whitelist
- `patterns.json` — discovered winning entry/exit conditions
- `lessons.json` — per-trade LLM debrief results
- `lp_lessons.json` — LP study lessons from top pool analysis
- `open_positions.json` — active DLMM positions with PnL + OOR timestamps

### Configuration (`config.js`)
All config from `.env`. Current defaults:
- `LOOP_INTERVAL_MS`: 1200000 (20min Hunter interval)
- `MAX_SOL_PER_POSITION`: 3 SOL
- `MAX_OPEN_POSITIONS`: 5
- `MIN_POOL_VOLUME_USD`: $50k
- `MIN_POOL_FEE_APR`: 20%
- `MAX_POOL_TVL_USD`: $150k
- `MIN_ORGANIC_SCORE`: 65
- `OOR_WAIT_MINUTES`: 30
- `TAKE_PROFIT_FEE_PCT`: 0.15 (15% of deployed)
- `TAKE_PROFIT_PERCENT`: 5%
- `STOP_LOSS_PERCENT`: -3%
- `MAX_HOLD_HOURS`: 48

### Telegram Commands
`/status /wallet /pnl /winrate /history /positions /review /evolve /pause /resume /closeall`
`/candidates` — show last pool scan results with organic scores
`/thresholds` — show all current filter thresholds
`/learn [pool_address]` — trigger LP study (optional specific pool)

### Key Module Responsibilities
| Module | Role |
|--------|------|
| `hunterAgent.js` | Pool scanning loop, LLM entry decisions, position opening |
| `healerAgent.js` | Position monitoring loop, exit execution |
| `llmAgent.js` | Builds decision context, calls OpenRouter, parses JSON response |
| `positionManager.js` | On-chain position open/close via Meteora DLMM SDK |
| `exitStrategy.js` | Exit rule evaluation (OOR/SL/TP/feeTP/maxHold/feeAPR) |
| `poolScanner.js` | Meteora API + DexScreener enrichment + organic score calculation |
| `thresholdEvolver.js` | Auto-adjusts .env thresholds from trade stats |
| `lpStudy.js` | LLM-powered LP pattern learning from top pools |
| `bundlerChecker.js` | MEV/bundler risk scoring |
| `telegramBot.js` | Bi-directional Telegram interface |
| `goyimChat.js` | Free-form chat with full agent context |

### Technology Stack
- **Runtime**: Node.js with ES modules (`"type": "module"`)
- **Blockchain**: `@solana/web3.js`, `@coral-xyz/anchor`, `@meteora-ag/dlmm`
- **LLM**: OpenRouter API
- **Telegram**: `telegraf`
- **External APIs**: Meteora datapi (`dlmm.datapi.meteora.ag`), DexScreener, Birdeye, Jupiter

### `src-vps/`
Production files for VPS deployment. `scripts/deploy.cjs` uploads these to `src/` on the VPS via SSH/SFTP, then restarts the PM2 process. Keep `src-vps/` in sync with `src/` when making changes.

## VPS Deployment
- Host: `152.42.167.126`, user: `root`, PM2 process: `goyim-agent`
- Deploy: `node scripts/deploy.cjs`
- The script: fetches LOL-SOL position address on-chain → patches `open_positions.json` → uploads all files → restarts PM2 → tails logs

## Important Notes
- `removeLiquidity` SDK call must use `fromBinId`/`toBinId` (not `binIds: number[]`) — v1.9.4 API
- LLM responses must be valid JSON; parsing failures in `llmAgent.js` skip execution
- MEV risk threshold for opening: score ≤ 50 (higher = riskier)
- `positionManager.js` base58 decoding is done manually (no bs58 dependency) to avoid version conflicts
