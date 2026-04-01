'use strict';

/**
 * simulator.js — Simulated price feed for paper trading.
 *
 * No API keys needed. Generates realistic price movements for
 * Gold, BTC, and US500 using random walks with mean reversion.
 * Prices start near real-world levels and move realistically.
 */

const logger = require('./logger');

// Starting prices (approximate real-world levels)
const BASE_PRICES = {
  BTC:    84000,
  ETH:    1800,
  SOL:    130,
  BNB:    600,
  EURUSD: 1.0850,
  GBPUSD: 1.2950,
  USDJPY: 149.50,
  AUDUSD: 0.6280,
  GOLD:   3100,
  SILVER: 34.50,
  OIL:    71.50,
  SPX:    5700,
  NQ:     19800,
  DAX:    22500,
};

// Volatility per tick (% of price) — realistic for 1-min candles
const VOLATILITY = {
  BTC:    0.0008,
  ETH:    0.0010,
  SOL:    0.0015,
  BNB:    0.0012,
  EURUSD: 0.0002,
  GBPUSD: 0.0002,
  USDJPY: 0.0003,
  AUDUSD: 0.0002,
  GOLD:   0.0004,
  SILVER: 0.0006,
  OIL:    0.0008,
  SPX:    0.0003,
  NQ:     0.0004,
  DAX:    0.0004,
};

// Current simulated prices
const currentPrices = {};
let initialized = false;

function init() {
  if (initialized) return;
  for (const [sym, base] of Object.entries(BASE_PRICES)) {
    // Start with slight random offset from base
    currentPrices[sym] = base * (1 + (Math.random() - 0.5) * 0.002);
  }
  initialized = true;
  logger.info('SIM', 'Simulated price feed initialized', {
    symbols: Object.keys(currentPrices).length,
    mode: 'PAPER TRADING — NO REAL MONEY',
  });
}

function randomWalk(price, vol) {
  // Random walk with slight mean reversion
  const drift = (Math.random() - 0.502) * vol * price; // tiny downward bias for realism
  const noise = (Math.random() - 0.5) * vol * price * 0.5;
  return Math.max(price * 0.95, price + drift + noise); // floor at 95% to prevent going to 0
}

/**
 * Generate a simulated candle for one symbol.
 */
function generateCandle(symbol) {
  init();
  const price = currentPrices[symbol] || BASE_PRICES[symbol] || 100;
  const vol = VOLATILITY[symbol] || 0.0005;

  // Generate OHLC
  const open = price;
  const move1 = randomWalk(open, vol);
  const move2 = randomWalk(open, vol);
  const move3 = randomWalk(open, vol);
  const close = randomWalk(open, vol);

  const high = Math.max(open, close, move1, move2, move3);
  const low = Math.min(open, close, move1, move2, move3);
  const volume = Math.floor(100 + Math.random() * 900); // 100-1000

  // Update current price for next tick
  currentPrices[symbol] = close;

  return {
    symbol,
    open: parseFloat(open.toFixed(6)),
    high: parseFloat(high.toFixed(6)),
    low: parseFloat(low.toFixed(6)),
    close: parseFloat(close.toFixed(6)),
    volume,
    timestamp: Date.now(),
  };
}

/**
 * Generate candles for all symbols (replaces broker.fetchBatch)
 */
function fetchBatch(symbols) {
  init();
  const out = {};
  for (const sym of symbols) {
    out[sym] = generateCandle(sym);
  }
  return out;
}

/**
 * Generate historical candles for warmup
 */
function generateHistory(symbol, count = 50) {
  init();
  const candles = [];
  let price = BASE_PRICES[symbol] || 100;
  const vol = VOLATILITY[symbol] || 0.0005;
  const now = Date.now();

  for (let i = count; i > 0; i--) {
    const open = price;
    const close = randomWalk(open, vol);
    const move1 = randomWalk(open, vol);
    const move2 = randomWalk(open, vol);
    const high = Math.max(open, close, move1, move2);
    const low = Math.min(open, close, move1, move2);

    candles.push({
      symbol,
      open: parseFloat(open.toFixed(6)),
      high: parseFloat(high.toFixed(6)),
      low: parseFloat(low.toFixed(6)),
      close: parseFloat(close.toFixed(6)),
      volume: Math.floor(100 + Math.random() * 900),
      timestamp: now - i * 60000, // 1 min apart
    });

    price = close;
  }

  currentPrices[symbol] = price;
  return candles;
}

module.exports = {
  init,
  fetchBatch,
  generateCandle,
  generateHistory,
  currentPrices,
};
