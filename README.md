# 🤖 Goyim DLMM Agent

AI-powered liquidity agent untuk Meteora DLMM di Solana.

## Stack
- **Meteora DLMM SDK** — manage posisi liquidity
- **lpagent.io** — pool analytics & volatility data  
- **Jupiter Exchange** — swap routing (opsional)
- **OpenRouter** — LLM brain (Claude / GPT / dll)

## Flow

```
[Loop tiap N detik]
       ↓
  Scan Pools          ← Meteora API + lpagent.io
       ↓
  Bundler Check       ← Solana RPC (tx pattern analysis)
       ↓
  LLM Decide          ← OpenRouter (strategy + bin range)
       ↓
  Execute             ← Open / Close / Hold position
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy dan isi config
cp .env.example .env
# Edit .env dengan API keys & wallet kamu

# 3. Run agent
npm start

# Development mode (auto-restart)
npm run dev
```

## File Structure

```
meridian-agent/
├── index.js               # Main agent loop
├── config.js              # Config dari .env
├── src/
│   ├── poolScanner.js     # Scan & filter pools terbaik
│   ├── bundlerChecker.js  # Deteksi bundler / suspicious activity
│   ├── llmAgent.js        # Otak AI via OpenRouter
│   └── positionManager.js # Open/close DLMM positions
└── .env.example
```

## LLM Strategies

| Strategy | Kondisi | Deskripsi |
|---|---|---|
| `spot` | Low volatility | Tight bin, stable pairs |
| `curve` | Medium volatility | Single-sided entry |
| `bid-ask` | High volatility | Earn dari swings |

## ⚠️ Notes

- Ini masih **skeleton** — `openPosition()` dan `closePosition()` perlu uncommenting tx signing setelah testing
- Test dulu di devnet sebelum mainnet!
- Max `riskScore` buat open posisi: **50**
- Confidence LLM minimum buat execute: **60%**
