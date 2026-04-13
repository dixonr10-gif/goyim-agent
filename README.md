# Goyim Agent — Autonomous Solana DLMM Trading Bot

AI-powered autonomous liquidity provision agent for **Meteora DLMM** on Solana. Runs two parallel agents (Hunter + Healer) that scan pools, analyze markets via LLM, execute on-chain trades, and self-improve from trade history.

---

## Features

- **Dual-Agent Architecture** — Hunter scans & opens, Healer monitors & closes
- **LLM-Powered Decisions** — Claude/GPT analyzes pool data, decides entry/exit with confidence scoring
- **Dynamic Position Sizing** — Weighted scoring (fee/TVL, volume trend, momentum, opportunity) determines SOL per trade
- **Trailing Take-Profit with HWM** — Activates at +6% PnL, tracks high-water mark, closes if PnL drops 3% from peak
- **Dynamic Bin Count** — Auto-adjusts 50 / 70 / 90 / 110 bins based on 1h price volatility (low → narrow, high → wide)
- **RSI Filter** — Skips pools where RSI > 80 (overbought / dump risk) or RSI < 30 (oversold / falling knife) before opening
- **Pool Memory** — Per-pool win rate tracking with bonus/penalty scoring; avoids repeat losers, boosts proven winners
- **Strict Hours Mode (14-20 WIB)** — Tighter SL (-4%), TP (+4%), trailing trail (-2%), higher min volume ($200k), shorter max hold (2h), and 2h auto-cooldown after any loss in window
- **LPAgent PnL Integration** — Accurate USD-precise PnL including unclaimed + claimed fees, replacing approximation-based PnL
- **Blacklist Auto-Decay** — Temporary blacklisted tokens auto-expire after 7 days (permanent blacklist preserved)
- **Meridian-style Lessons** — Per-trade observation captured (max 20 retained), surfaced to LLM via prompt context
- **Exit Reason + Bin Range Tracking** — Every closed trade records `exitReason` (sl/tp/trailing/oor/feeTP/maxHold/feeAPR) and final `binRange` for post-mortem analysis
- **BidAsk Strategy** — Bin range 40% below / 60% above active bin, biased for upside capture
- **Spot Strategy** — Symmetrical range with 10% upside buffer for trending pools
- **Organic Score Filter** — Detects wash trading / bot spikes, only enters organic pools
- **Self-Learning System** — Post-trade LLM debrief, pattern discovery, auto-rewriting agent brain
- **Threshold Evolution** — Auto-adjusts filter thresholds based on win rate & avg PnL
- **3 Candidate Sources** — Meteora API (volume + fees) + DexScreener trending + Meteora fee/TVL ratio
- **Token Safety Checks** — DexScreener + Birdeye + on-chain security (mint/freeze authority, top holders)
- **MEV/Bundler Detection** — Scores bundler risk before opening positions
- **Auto-Swap** — Automatically swaps leftover tokens to SOL after closing positions
- **Telegram Bot** — Full control & monitoring via Telegram with 20+ commands
- **Free-Form Chat** — Chat naturally with the agent about positions, market, strategy
- **CA Scanner** — Send any contract address to Telegram for instant token analysis
- **Watchdog** — Auto-restarts Healer if it becomes unresponsive
- **Daily P&L Report** — Automated daily performance summary via Telegram
- **Cooldown System** — Per-token cooldown after close/failure to avoid re-entering too fast
- **Blacklist Management** — Permanent + temporary token blacklisting (with 7-day auto-decay)

---

## Requirements

| Requirement | Detail |
|---|---|
| **Node.js** | v18 or higher |
| **VPS** | Ubuntu 22.04+ recommended (DigitalOcean $6/mo, 1GB RAM cukup) |
| **Solana Wallet** | Funded with SOL (minimum ~1 SOL untuk mulai) |
| **RPC Endpoint** | Helius recommended (free tier available) |
| **OpenRouter API Key** | Untuk LLM brain (Claude Haiku default — murah) |
| **Telegram Bot** | Optional tapi sangat recommended untuk monitoring |

---

## API Keys yang Dibutuhkan

### 1. Helius RPC URL

Helius memberikan RPC endpoint yang cepat dan reliable untuk Solana.

1. Buka [helius.dev](https://helius.dev)
2. Register / Login
3. Dashboard -> buat project baru
4. Copy **RPC URL** (format: `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`)

> Bisa juga pakai RPC lain (QuickNode, Alchemy, dll), tapi Helius paling stabil untuk Meteora.

### 2. OpenRouter API Key

OpenRouter menyediakan akses ke berbagai LLM (Claude, GPT, dll) dengan satu API key.

1. Buka [openrouter.ai](https://openrouter.ai)
2. Register / Login
3. Dashboard -> **API Keys** -> Create New Key
4. Copy key (format: `sk-or-v1-...`)
5. Top up credit (minimum $5, Claude Haiku sangat murah ~$0.01 per decision)

### 3. Wallet Private Key

Private key wallet Solana yang akan digunakan bot untuk trading.

**Dari Phantom:**
1. Buka Phantom -> Settings -> Security & Privacy
2. Export Private Key -> masukkan password
3. Copy base58 private key

**Dari Solflare:**
1. Buka Solflare -> Settings -> Export Private Key
2. Copy base58 string

> **PENTING: Jangan share private key ke siapapun! Gunakan wallet khusus untuk bot, jangan wallet utama.**

### 4. Telegram Bot Token (optional)

1. Buka Telegram, cari **@BotFather**
2. Ketik `/newbot`
3. Ikuti instruksi (nama bot, username)
4. Copy **Bot Token** (format: `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`)

### 5. Telegram Chat ID (optional)

1. Setelah buat bot, start chat dengan bot kamu
2. Buka browser: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Kirim pesan apapun ke bot
4. Refresh halaman, cari `"chat":{"id":XXXXXXX}`
5. Copy angka tersebut sebagai Chat ID

---

## VPS Setup (DigitalOcean)

### Step 1: Buat Droplet

1. Register di [digitalocean.com](https://www.digitalocean.com)
2. Create Droplet:
   - **Image:** Ubuntu 22.04 LTS
   - **Plan:** Basic $6/mo (1 vCPU, 1GB RAM) — cukup
   - **Region:** Singapore (SGP1) untuk latency rendah
   - **Authentication:** Password atau SSH key
3. Catat IP address droplet

### Step 2: Login ke VPS

```bash
ssh root@YOUR_VPS_IP
```

### Step 3: Install Node.js 18+

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
node --version  # pastikan v18+
```

### Step 4: Install PM2

```bash
npm install -g pm2
```

### Step 5: Clone Repository

```bash
cd /root
git clone https://github.com/dixonr10-gif/goyim-agent.git
cd goyim-agent
npm install
```

### Step 6: Setup Environment

```bash
cp .env.example .env
nano .env
```

Isi semua field yang diperlukan (lihat bagian [Konfigurasi](#konfigurasi) di bawah).

### Step 7: Jalankan Bot

```bash
pm2 start index.js --name goyim-agent
pm2 save
pm2 startup  # auto-start setelah reboot
```

### Useful PM2 Commands

```bash
pm2 logs goyim-agent          # Lihat logs realtime
pm2 logs goyim-agent --lines 200  # Lihat 200 baris terakhir
pm2 restart goyim-agent        # Restart bot
pm2 stop goyim-agent           # Stop bot
pm2 monit                      # Monitor CPU/RAM
```

---

## Konfigurasi

Semua konfigurasi ada di file `.env`. Copy dari `.env.example` dan sesuaikan.

### Required

| Variable | Deskripsi |
|---|---|
| `RPC_URL` | Solana RPC endpoint (Helius recommended) |
| `WALLET_PRIVATE_KEY` | Base58 private key wallet Solana |
| `OPENROUTER_API_KEY` | API key dari OpenRouter |
| `LPAGENT_API_KEY` | API key dari LPAgent (untuk akurat USD-precise PnL termasuk fees) |

### Trading Parameters

| Variable | Default | Deskripsi |
|---|---|---|
| `MAX_SOL_PER_POSITION` | `8` | Maksimum SOL per posisi (cap dari dynamic sizing) |
| `MAX_OPEN_POSITIONS` | `6` | Maksimum posisi terbuka bersamaan |
| `LOOP_INTERVAL_MS` | `1080000` | Interval Hunter scan (18 menit) |
| `MAX_HOLD_HOURS` | `3` | Maksimum waktu hold posisi (jam) |

### Take Profit & Stop Loss

| Variable | Default | Deskripsi |
|---|---|---|
| `TAKE_PROFIT_PERCENT` | `8` | Take profit at +8% PnL |
| `STOP_LOSS_PCT` | `-6` | Stop loss at -6% PnL |
| `TRAILING_TP_ACTIVATION` | `6` | Trailing TP aktif setelah +6% PnL (mulai track HWM) |
| `TRAILING_TP_TRAIL` | `3` | Trail 3% dari peak PnL — close jika PnL turun 3% dari HWM |
| `TAKE_PROFIT_FEE_PCT` | `0.15` | Fee TP: close jika fees >= 15% of deployed SOL |
| `MIN_FEE_APR_TO_HOLD` | `10` | Minimum fee APR untuk tetap hold (%) |
| `OOR_WAIT_MINUTES` | `30` | Grace period setelah out-of-range (menit) |
| `SKIP_PUMP_1H_THRESHOLD` | `30` | Skip pool jika token sudah pump > 30% dalam 1 jam (anti-FOMO entry) |

### Strict Hours Mode

Periode strict hours mengaktifkan filter trading yang lebih ketat untuk menghindari volatilitas tinggi. Default 14:00–20:00 WIB. Saat aktif: SL -4%, TP +4%, trailing trail -2%, min volume $200k, max hold 2h, dan auto-cooldown 2 jam jika ada loss di window ini.

| Variable | Default | Deskripsi |
|---|---|---|
| `STRICT_HOURS_START` | `14` | Jam mulai strict mode (WIB, 0-23) |
| `STRICT_HOURS_END` | `20` | Jam selesai strict mode (WIB, 0-23) |

### Pool Filters

| Variable | Default | Deskripsi |
|---|---|---|
| `MIN_POOL_VOLUME_USD` | `100000` | Minimum volume 24h ($) |
| `MIN_POOL_FEE_APR` | `1.0` | Minimum fee APR (%) |
| `MIN_ORGANIC_SCORE` | `35` | Minimum organic score (0-100) |
| `MAX_POOL_TVL_USD` | `600000` | Maximum TVL — reject oversaturated pools ($) |

### Token Filters

| Variable | Default | Deskripsi |
|---|---|---|
| `MIN_TOKEN_AGE_HOURS` | `1` | Minimum umur token (jam) |
| `MAX_TOKEN_AGE_DAYS` | `30` | Maximum umur token (hari) |
| `MIN_VOLUME_24H` | `100000` | Minimum volume 24h token ($) |
| `MAX_VOLUME_24H` | `15000000` | Maximum volume 24h token ($) |
| `MIN_LIQUIDITY_USD` | `15000` | Minimum liquidity ($) |
| `MAX_LIQUIDITY_USD` | `1000000` | Maximum liquidity ($) |

### Other Settings

| Variable | Default | Deskripsi |
|---|---|---|
| `AUTO_SWAP_ENABLED` | `true` | Auto-swap leftover tokens ke SOL |
| `AUTO_SWAP_MIN_USD` | `1` | Minimum USD value untuk auto-swap |
| `TOKEN_COOLDOWN_HOURS` | `1` | Cooldown per token setelah close (jam) |
| `SKIP_STABLE_PAIRS` | `true` | Skip stable/large-cap pairs |
| `BLACKLISTED_TOKENS` | `JUP,BONK,...` | Comma-separated token symbols to never trade |
| `ENABLE_POST_TRADE_ANALYSIS` | `false` | Enable LLM post-trade debrief (extra cost) |

### LLM Models

| Variable | Default | Deskripsi |
|---|---|---|
| `OPENROUTER_MODEL` | `anthropic/claude-3-haiku` | Model utama (decision making) |
| `LLM_MODEL_SMART` | `anthropic/claude-sonnet-4` | Model untuk analisis mendalam |
| `LLM_MODEL_FAST` | `anthropic/claude-haiku-4.5` | Model untuk quick checks |

---

## Telegram Commands

### Status & Info
| Command | Deskripsi |
|---|---|
| `/status` | Status agent (running/paused, positions, balance) |
| `/wallet` | Saldo SOL + token balances |
| `/positions` | Posisi aktif dengan real-time PnL |
| `/pnl` | P&L summary (total, realized, unrealized) |
| `/winrate` | Win rate statistics |
| `/history` | Riwayat closed trades |

### Pool & Analysis
| Command | Deskripsi |
|---|---|
| `/candidates` | Hasil pool scan terakhir dengan scores |
| `/thresholds` | Semua filter thresholds saat ini |
| `/lessons` | Lessons learned dari post-trade analysis |
| `/learn [pool]` | Study LP patterns dari top pools |

### Management
| Command | Deskripsi |
|---|---|
| `/pause` | Pause agent (stop opening new positions) |
| `/resume` | Resume agent |
| `/closeall` | Close semua posisi aktif |
| `/evolve` | Trigger threshold evolution manual |
| `/review` | Trigger daily review manual |

### Token Management
| Command | Deskripsi |
|---|---|
| `/cooldowns` | Lihat active token cooldowns |
| `/blacklist` | Lihat blacklisted tokens |
| `/unblacklist [SYM]` | Remove token dari blacklist |
| `/watchlist` | Token watch list |
| `/ghosts` | Ghost positions (orphaned on-chain) |

### Utility
| Command | Deskripsi |
|---|---|
| `/logs [keyword]` | PM2 logs (optional keyword filter) |
| `/recordclose SYM PNL SOL` | Catat manual close (untuk posisi close di Meteora UI) |
| `/help` | Daftar semua commands |

### CA Scanner & Chat
- **Kirim contract address** langsung ke chat untuk instant token analysis
- **Chat bebas** — tanya apapun soal positions, market, strategy

---

## How It Works

### Architecture

```
                    index.js (Orchestrator)
                   /                       \
          Hunter Agent                 Healer Agent
     (10min / 30min strict)          (every 1 min)
              |                            |
    1. Learn (brain/patterns)    1. Sync on-chain positions
    2. Scan 80+ pools (3 src):   2. Calculate real-time PnL
       - Meteora API (vol+fees)     (LPAgent USD-precise)
       - DexScreener trending    3. Check exit rules:
       - Meteora fee/TVL ratio      - Stop Loss (-6% / -4% strict)
    3. Filter & enrich              - Take Profit (+8% / +4% strict)
    4. Analyze (scoring 0-100)      - Out of Range (OOR + grace)
    5. RSI filter                   - Trailing TP HWM update
       (skip RSI > 80 or < 30)        (activate +6%, trail -3%)
    6. LLM decision                 - Fee Take Profit
    7. Pool Memory check            - Max Hold Time
       (per-pool win rate)          - Fee APR Floor
    8. Token safety + bundler    4. Execute close
    9. Execute open              5. Auto-swap leftover tokens
                                 6. Record exitReason + binRange
                                 7. Post-trade lessons (Meridian)
```

**Hunter flow (10min / 30min strict):** scan 80+ pools → pre-filter (vol/TVL/APR/age) → DexScreener enrich (organic score, multi-timeframe trend) → market analysis (score 0-100) → **RSI filter** (skip > 80 / < 30) → LLM decision with full context → **Pool Memory check** (skip if loss streak ≥ 2x on same pool) → token safety + MEV/bundler check → dynamic position sizing → **open position**.

**Healer flow (1 min loop):** sync on-chain state → fetch USD-precise PnL via LPAgent (includes unclaimed + claimed fees) → evaluate exit rules in priority order (SL → TP → OOR → fee TP → trailing HWM update → max hold → fee APR floor) → if any triggers, **close position** + auto-swap residual tokens → record `exitReason` + final `binRange` → post-trade LLM debrief.

### Hunter Agent — Entry Logic

1. **Scan** — Fetches pools from 3 sources (Meteora volume/fees sort, DexScreener trending tokens, Meteora fee/TVL ratio). Total ~400+ pools scanned per cycle.
2. **Pre-Filter** — Volume > $100K, TVL > $5K, APR > 1%, age 1h-30d, not stablecoin-only.
3. **DexScreener Enrich** — Multi-timeframe volume analysis (5m/1h/6h/24h), uptrend detection, organic score calculation.
4. **Post-Filter** — Max TVL, minimum organic score, blacklist/cooldown check.
5. **Market Analysis** — Score each pool 0-100 (volatility, trend, fee momentum).
6. **LLM Decision** — Full context sent to Claude/GPT. Returns action (open/skip/hold), confidence, strategy, target pool.
7. **Safety Checks** — Token checker (DexScreener + Birdeye + on-chain), bundler/MEV risk, dump filter, ATH proximity filter.
8. **Position Sizing** — Weighted scoring determines SOL amount:

| Total Score | SOL |
|---|---|
| > 85 | 8 SOL |
| 75-85 | 6 SOL |
| 65-74 | 5 SOL |
| 50-64 | 4 SOL |
| 40-49 | 3 SOL |
| < 40 | SKIP |

9. **Execute** — Opens DLMM position with dynamic bin count & strategy (spot/bidask).

### Healer Agent — Exit Logic

Checks every 1 minute, in priority order:

1. **Out of Range** — Position bins are outside price range -> 30-60min grace period, then close
2. **Fee Take Profit** — Claimable fees >= 15% of deployed SOL -> close
3. **Tiered Stop Loss** — Tier 1: -6% (2-tick confirm), Tier 2: -10% hard SL (instant), Tier 3: -15% panic SL (instant, SOL-fallback if USD unavailable)
4. **Take Profit** — PnL >= +25% -> close
5. **Trailing TP** — If PnL ever hits +6%, trail 3% from peak. If PnL drops 3% from highest -> close
6. **Max Hold** — Position older than 48h (2h strict) -> close
7. **Fee APR Floor** — Pool fee APR < 10% -> close (pool dried up)

### Self-Learning System

- **Post-Trade Analyzer** — LLM debriefs each closed trade, extracts lessons -> `data/lessons.json`
- **Pattern Learner** — Discovers winning conditions every 5 trades -> `data/patterns.json`
- **Threshold Evolver** — Auto-adjusts .env filter thresholds based on win rate + avg PnL
- **Pool Memory** — Tracks per-pool performance, boosts/penalizes future scoring

---

## File Structure

```
goyim-agent/
├── index.js                    # Orchestrator — starts Hunter + Healer
├── config.js                   # All config from .env
├── .env                        # Environment variables (create from .env.example)
├── .env.example                # Template with all variables
├── src/                        # Source (deployed to VPS)
│   ├── hunterAgent.js          # Pool scanning, LLM entry decisions, position opening
│   ├── healerAgent.js          # Position monitoring, exit execution
│   ├── poolScanner.js          # Meteora API + DexScreener enrichment + organic scoring
│   ├── llmAgent.js             # Builds LLM context, calls OpenRouter, parses response
│   ├── positionManager.js      # On-chain DLMM position open/close via Meteora SDK
│   ├── exitStrategy.js         # Exit rule evaluation (OOR/SL/TP/trailing/feeTP/etc)
│   ├── tokenChecker.js         # DexScreener + Birdeye + on-chain token safety
│   ├── bundlerChecker.js       # MEV/bundler risk scoring
│   ├── marketAnalyzer.js       # Pool scoring (volatility, trend, fee momentum)
│   ├── tradeMemory.js          # Trade history, stats, blacklist/whitelist
│   ├── postTradeAnalyzer.js    # LLM debrief per closed trade
│   ├── patternLearner.js       # Discovers winning patterns from trade history
│   ├── thresholdEvolver.js     # Auto-adjusts .env thresholds from stats
│   ├── poolMemory.js           # Per-pool performance tracking
│   ├── telegramBot.js          # Telegram interface (commands + chat)
│   ├── goyimChat.js            # Free-form chat with agent context
│   ├── autoSwap.js             # Auto-swap leftover tokens to SOL
│   ├── cooldownManager.js      # Per-token cooldown management
│   ├── blacklistManager.js     # Token blacklist management
│   ├── feeCompounder.js        # Fee claiming during uptrends
│   ├── walletInfo.js           # Wallet balance display
│   ├── cryptoPrice.js          # SOL/BTC/ETH price fetching
│   ├── dailyReport.js          # Automated daily P&L report
│   ├── healthCheck.js          # Agent health monitoring
│   └── ...
├── src-vps/                    # Production files (synced to VPS on deploy)
├── data/                       # Persistent state
│   ├── agent_brain.json        # Self-written trading rules (versioned)
│   ├── trade_memory.json       # Full trade history + stats
│   ├── open_positions.json     # Active DLMM positions
│   ├── patterns.json           # Discovered winning conditions
│   ├── lessons.json            # Per-trade LLM debrief results
│   └── pool_memory.json        # Per-pool performance tracking
└── scripts/
    └── deploy.cjs              # VPS deployment script (SSH/SFTP + PM2 restart)
```

---

## Risk Warning

- **Trading crypto memiliki risiko tinggi.** Harga bisa turun drastis dalam hitungan menit.
- **Impermanent Loss (IL)** adalah risiko utama di DLMM. Token bisa dump setelah entry.
- **Smart contract risk** — Meteora protocol bisa mengalami bug atau exploit.
- **Bot bukan jaminan profit.** Past performance does not guarantee future results.
- **Gunakan modal yang siap hilang.** Jangan pakai uang yang dibutuhkan untuk kebutuhan sehari-hari.
- **Selalu monitor bot** via Telegram. Jangan tinggal tanpa pengawasan untuk waktu lama.

---

## Troubleshooting

### Bot tidak jalan / crash loop
```bash
pm2 logs goyim-agent --lines 50    # Cek error
pm2 restart goyim-agent            # Restart
```

### Hunter STALE warning (saat strict hours 14-20 WIB)
**Normal behavior** — Hunter di-pause 2 jam setelah loss di strict hours window. Cek logs:
```bash
pm2 logs goyim-agent --lines 50 | grep "Strict loss cooldown"
# Output: "[Hunter] ⏰ Strict loss cooldown: Xm remaining (resume HH:MM WIB)"
```
Cooldown ter-persist di `data/strict_cooldown.json` dan akan auto-restore setelah restart. Tidak perlu intervensi — Hunter akan resume otomatis.

### Bot tidak open posisi sama sekali
Cek beberapa hal:
- **Blacklist** — `/blacklist` di Telegram, lihat token-token yang ke-block
- **Brain paralysis** — kalau win rate < 30%, brain mungkin terlalu konservatif. Cek `data/agent_brain.json`
- **Strict cooldown aktif** — lihat troubleshooting di atas
- **Pool Memory loss streak** — pool yang sudah 2x loss berturut akan di-skip 24 jam
- **RSI filter** — semua kandidat mungkin overbought (RSI > 80) atau oversold (< 30)

### PnL selalu N/A di /positions
File `lastPnlPct` tidak ke-persist (bug race condition):
```bash
pm2 restart goyim-agent
```
Setelah restart, tunggu 1 cycle Healer (~2 menit), lalu cek `/positions` lagi.

### Swap failed: 429 Too Many Requests
RPC rate limit. Bot akan auto-retry dengan slippage berbeda (100/300/500/1000bps). Kalau persistent:
- Upgrade Helius plan ke paid tier
- Atau ganti ke RPC alternative (QuickNode, Triton)

### Healer STALE warning
Watchdog akan auto-restart, tapi jika terus muncul:
```bash
pm2 restart goyim-agent
```

### Position OOR langsung setelah open
**Normal** — grace period berbeda berdasarkan arah:
- **OOR ke kanan** (token pump, bin di bawah active) → grace **35 menit** (kasih waktu fee accumulation)
- **OOR ke kiri** (token dump, bin di atas active) → grace **15 menit** (cut loss cepat)

Kalau mau force close, gunakan `/closeall` atau close manual via Meteora UI.

### Transaction simulation failed
Beberapa kemungkinan:
- **Pool deprecated/migrated** — token mungkin sudah pindah ke pool baru, bot akan auto-blacklist
- **SOL kurang** untuk gas fee (minimum ~0.05 SOL untuk close transaction)
- **Bin range corrupted** — close manual via Meteora UI, lalu `/recordclose SYMBOL PNL_% SOL_AMOUNT`

### RPC rate limit (429 errors)
- Ganti ke Helius RPC (free tier: 30 req/s)
- Atau upgrade RPC plan

### "SOL tidak cukup" 
- Top up SOL ke wallet bot
- Minimum ~0.3 SOL diperlukan per posisi + gas fees

### Position tidak bisa close
- Cek apakah position masih valid di [Meteora UI](https://app.meteora.ag/dlmm)
- Manual close via Meteora UI jika perlu
- Catat manual: `/recordclose SYMBOL PNL_% SOL_AMOUNT`

### LLM error / non-JSON response
- Biasanya transient, bot akan retry next cycle
- Jika terus terjadi, cek OpenRouter credit balance

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | Node.js (ES Modules) |
| Blockchain | `@solana/web3.js`, `@coral-xyz/anchor`, `@meteora-ag/dlmm` |
| LLM | OpenRouter API (Claude Haiku default) |
| Telegram | `telegraf` |
| Process Manager | PM2 |
| APIs | Meteora, DexScreener, Birdeye, Jupiter |

---

## License

MIT
