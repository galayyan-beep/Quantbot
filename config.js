'use strict';

/**
 * config.js — Centralized configuration for all instruments, default parameters,
 * and constants used across the bot.
 *
 * Import from here instead of hardcoding symbols in multiple files.
 */

// ─── Instrument definitions ──────────────────────────────────────────────────
const INSTRUMENTS = {
  BTC:    { category: 'crypto',    spread: 0.0002 },
  ETH:    { category: 'crypto',    spread: 0.0003 },
  SOL:    { category: 'crypto',    spread: 0.0005 },
  BNB:    { category: 'crypto',    spread: 0.0004 },
  EURUSD: { category: 'forex',     spread: 0.0001 },
  GBPUSD: { category: 'forex',     spread: 0.0001 },
  USDJPY: { category: 'forex',     spread: 0.0001 },
  AUDUSD: { category: 'forex',     spread: 0.0001 },
  GOLD:   { category: 'commodity', spread: 0.0003 },
  SILVER: { category: 'commodity', spread: 0.0004 },
  OIL:    { category: 'commodity', spread: 0.0005 },
  SPX:    { category: 'index',     spread: 0.0002 },
  NQ:     { category: 'index',     spread: 0.0002 },
  DAX:    { category: 'index',     spread: 0.0002 },
};

const SYMBOLS = Object.keys(INSTRUMENTS);

// ─── Default trading parameters ──────────────────────────────────────────────
const DEFAULT_PARAMS = {
  riskPercent: 2,
  atrMultiplier: 2.5,
  minScore: 4,
  momentumThreshold: 0.0035,
  rsiBuyLevel: 28,
  rsiSellLevel: 72,
  cooldownCandles: 12,
  minHoldCandles: 6,
  maxPositions: 5,
};

// ─── Risk constants ──────────────────────────────────────────────────────────
const MAX_TOTAL_EXPOSURE = 100;
const EXPOSURE_TOLERANCE_PCT = 0.02;
const MAX_CRYPTO_BASKET_EXPOSURE = 70;

// ─── Timing constants ────────────────────────────────────────────────────────
const TICK_INTERVAL_MS = 2000;
const MAX_CANDLE_HIST = 220;
const WARMUP_CANDLES = 55;
const INITIAL_CAPITAL = 10000;

// ─── Correlation groups ──────────────────────────────────────────────────────
const CORRELATION_GROUPS = [
  new Set(['BTC', 'ETH', 'SOL', 'BNB']),
  new Set(['EURUSD', 'GBPUSD', 'AUDUSD']),
  new Set(['GOLD', 'SILVER']),
  new Set(['SPX', 'NQ', 'DAX']),
];

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
};
