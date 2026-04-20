// config.js — semua setting agent dari .env

import dotenv from "dotenv";
dotenv.config();

export const config = {
  // Solana
  rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
  rpcUrlFallback: process.env.RPC_URL_FALLBACK || "https://api.mainnet-beta.solana.com",
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY,

  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  // LLM
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  openRouterModel: process.env.OPENROUTER_MODEL || "anthropic/claude-3-haiku",
  openRouterModelSmart: process.env.LLM_MODEL_SMART || "anthropic/claude-sonnet-4",
  openRouterModelFast: process.env.LLM_MODEL_FAST || "anthropic/claude-haiku-4.5",

  // Agent behavior
  loopIntervalMs: Number(process.env.LOOP_INTERVAL_MS) || 1_200_000,
  maxSolPerPosition: Number(process.env.MAX_SOL_PER_POSITION) || 3,
  minPoolVolumeUsd: Number(process.env.MIN_POOL_VOLUME_USD) || 50_000,
  minPoolFeeApr: Number(process.env.MIN_POOL_FEE_APR) || 20,
  minFeeAprFilter: Number(process.env.MIN_FEE_APR_FILTER) || 10,
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS) || 5,
  maxDeployPer24h: Number(process.env.MAX_DEPLOY_PER_24H) || 5,
  tokenCooldownHours: Number(process.env.TOKEN_COOLDOWN_HOURS) || 0.5,

  // Meridian features
  outOfRangeWaitMinutes: Number(process.env.OOR_WAIT_MINUTES) || 30,
  minSolToOpen: Number(process.env.MIN_SOL_TO_OPEN) || 0.3,
  takeProfitFeePct: Number(process.env.TAKE_PROFIT_FEE_PCT) || 0.15,
  minOrganicScore: Number(process.env.MIN_ORGANIC_SCORE) || 65,
  maxTvlUsd: Number(process.env.MAX_POOL_TVL_USD) || 150_000,
  lpagentApiKey: process.env.LPAGENT_API_KEY || "",
  trailingTpActivation: parseFloat(process.env.TRAILING_TP_ACTIVATION) || 6,
  trailingTpTrail: parseFloat(process.env.TRAILING_TP_TRAIL) || 3,
  skipStablePairs: (process.env.SKIP_STABLE_PAIRS ?? "true") !== "false",
  minTokenAgeHours: parseFloat(process.env.MIN_TOKEN_AGE_HOURS) || 1,
  maxTokenAgeDays:  parseFloat(process.env.MAX_TOKEN_AGE_DAYS)  || 30,
  minVolume24h:     parseFloat(process.env.MIN_VOLUME_24H)   || 100_000,
  maxVolume24h:     parseFloat(process.env.MAX_VOLUME_24H)   || 15_000_000,
  minLiquidityUsd:  parseFloat(process.env.MIN_LIQUIDITY_USD) || 15_000,
  maxLiquidityUsd:  parseFloat(process.env.MAX_LIQUIDITY_USD) || 1_000_000,

  // Bin Array Init Cost Guard: Meteora DLMM charges ~0.07144 SOL rent per
  // uninitialized BinArray (70 bins), and the bot never closes the account so
  // the rent is non-refundable. Skip deploys whose estimated init cost exceeds
  // the cap to avoid eating 40–80% of target profit on sparse meme pools.
  binArrayInitCostSol: Number(process.env.BIN_ARRAY_INIT_COST_SOL) || 0.07144,
  maxBinArrayInitSol:  Number(process.env.MAX_BIN_ARRAY_INIT_SOL)  || 0.07144,
};

// Validasi wajib ada
const required = ["walletPrivateKey", "openRouterApiKey"];
for (const key of required) {
  if (!config[key]) throw new Error(`Missing config: ${key} (check .env)`);
}
