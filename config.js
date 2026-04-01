'use strict';

/**
 * config.js — Centralized configuration for all instruments, default parameters,
 * and constants used across the bot.
 *
 * Import from here instead of hardcoding symbols in multiple files.
 */

// ─── Instrument definitions ──────────────────────────────────────────────────
// peakHoursUTC: [start, end] — only open NEW positions during peak liquidity.
// Crypto trades 24/7 but prefers US+Asia overlap.
const INSTRUMENTS = {
  BTC:    { category: 'crypto',    spread: 0.0002, peakHoursUTC: [0, 23] },
  ETH:    { category: 'crypto',    spread: 0.0003, peakHoursUTC: [0, 23] },
  SOL:    { category: 'crypto',    spread: 0.0005, peakHoursUTC: [0, 23] },
  BNB:    { category: 'crypto',    spread: 0.0004, peakHoursUTC: [0, 23] },
  EURUSD: { category: 'forex',     spread: 0.0001, peakHoursUTC: [7, 16] },  // London + NY overlap
  GBPUSD: { category: 'forex',     spread: 0.0001, peakHoursUTC: [7, 16] },
  USDJPY: { category: 'forex',     spread: 0.0001, peakHoursUTC: [0, 16] },  // Tokyo + London
  AUDUSD: { category: 'forex',     spread: 0.0001, peakHoursUTC: [0, 8] },   // Sydney + Tokyo
  GOLD:   { category: 'commodity', spread: 0.0003, peakHoursUTC: [7, 17] },  // London + NY
  SILVER: { category: 'commodity', spread: 0.0004, peakHoursUTC: [7, 17] },
  OIL:    { category: 'commodity', spread: 0.0005, peakHoursUTC: [13, 20] }, // NY session
  SPX:    { category: 'index',     spread: 0.0002, peakHoursUTC: [13, 20] }, // US market hours
  NQ:     { category: 'index',     spread: 0.0002, peakHoursUTC: [13, 20] },
  DAX:    { category: 'index',     spread: 0.0002, peakHoursUTC: [7, 16] },  // European hours
};

const SYMBOLS = Object.keys(INSTRUMENTS);

// ─── Focus instruments — only trade these ────────────────────────────────────
// The bot will only open NEW positions on these symbols.
// All other instruments are used for data/correlation but NOT traded.
const FOCUS_SYMBOLS = ['GOLD', 'BTC', 'SPX'];

// ─── Default trading parameters ──────────────────────────────────────────────
// Tuned for active trading on a ~$100 live account.
const DEFAULT_PARAMS = {
  riskPercent: 1.5,           // risk 1.5% per trade ($1.50 on $100)
  atrMultiplier: 2.5,        // stop loss at 2.5× ATR
  minScore: 1,               // single pillar = trade
  momentumThreshold: 0.001,   // 0.1% momentum (ultra sensitive)
  rsiBuyLevel: 32,
  rsiSellLevel: 68,
  cooldownCandles: 5,         // 10 seconds between trades per symbol
  minHoldCandles: 3,          // hold at least 6 seconds
  maxPositions: 4,
};

// ─── Risk constants ──────────────────────────────────────────────────────────
const MAX_TOTAL_EXPOSURE = 100;
const EXPOSURE_TOLERANCE_PCT = 0.02;
const MAX_CRYPTO_BASKET_EXPOSURE = 70;

// ─── Timing constants ────────────────────────────────────────────────────────
const TICK_INTERVAL_MS = 2000;
const MAX_CANDLE_HIST = 220;
const WARMUP_CANDLES = 25;  // faster startup — trade sooner
const INITIAL_CAPITAL = 100;  // $100 live account

// ─── Correlation groups ──────────────────────────────────────────────────────
const CORRELATION_GROUPS = [
  new Set(['BTC', 'ETH', 'SOL', 'BNB']),
  new Set(['EURUSD', 'GBPUSD', 'AUDUSD']),
  new Set(['GOLD', 'SILVER']),
  new Set(['SPX', 'NQ', 'DAX']),
];

// ─── Peak hours check ────────────────────────────────────────────────────────
function isInPeakHours(symbol) {
  const info = INSTRUMENTS[symbol];
  if (!info || !info.peakHoursUTC) return true; // no restriction
  const [start, end] = info.peakHoursUTC;
  const hour = new Date().getUTCHours();
  if (start <= end) return hour >= start && hour <= end;
  return hour >= start || hour <= end; // wraps around midnight
}

module.exports = {
  INSTRUMENTS,
  SYMBOLS,
  DEFAULT_PARAMS,
  MAX_TOTAL_EXPOSURE,
  EXPOSURE_TOLERANCE_PCT,
  MAX_CRYPTO_BASKET_EXPOSURE,
  TICK_INTERVAL_MS,
  MAX_CANDLE_HIST,
  WARMUP_CANDLES,
  INITIAL_CAPITAL,
  CORRELATION_GROUPS,
  isInPeakHours,
  FOCUS_SYMBOLS,
};
