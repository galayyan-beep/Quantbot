'use strict';

const logger = require('./logger');
const { CapitalClient } = require('./capitalApi');

const INSTRUMENTS = {
  BTC:    { category: 'crypto', spread: 0.0002 },
  ETH:    { category: 'crypto', spread: 0.0003 },
  SOL:    { category: 'crypto', spread: 0.0005 },
  BNB:    { category: 'crypto', spread: 0.0004 },
  EURUSD: { category: 'forex', spread: 0.0001 },
  GBPUSD: { category: 'forex', spread: 0.0001 },
  USDJPY: { category: 'forex', spread: 0.0001 },
  AUDUSD: { category: 'forex', spread: 0.0001 },
  GOLD:   { category: 'commodity', spread: 0.0003 },
  SILVER: { category: 'commodity', spread: 0.0004 },
  OIL:    { category: 'commodity', spread: 0.0005 },
  SPX:    { category: 'index', spread: 0.0002 },
  NQ:     { category: 'index', spread: 0.0002 },
  DAX:    { category: 'index', spread: 0.0002 },
};

const prices = {};
let broker = null;

function init(savedPrices = {}, opts = {}) {
  for (const sym of Object.keys(INSTRUMENTS)) {
    prices[sym] = savedPrices[sym] || 0;
  }
  const paperTrading = opts.paperTrading !== undefined
    ? !!opts.paperTrading
    : process.env.PAPER_TRADING !== 'false';
  broker = new CapitalClient({ paperTrading });
  logger.info('PRICES', 'Capital.com market data adapter initialized', { paperTrading });
}

function setMode({ paperTrading }) {
  if (!broker) broker = new CapitalClient({ paperTrading: !!paperTrading });
  broker.useMode({ paperTrading: !!paperTrading });
}

async function tick() {
  if (!broker) init({}, {});
  const symbols = Object.keys(INSTRUMENTS);
  const candles = await broker.fetchBatch(symbols);
  for (const sym of symbols) {
    if (candles[sym] && Number.isFinite(candles[sym].close)) {
      prices[sym] = candles[sym].close;
    }
  }
  return candles;
}

function executionPrice(symbol, side) {
  const p = prices[symbol] || 0;
  const half = (INSTRUMENTS[symbol]?.spread || 0) * p;
  return side === 'buy' ? p + half : p - half;
}

function currentPrices() {
  return { ...prices };
}

function getSymbols() {
  return Object.keys(INSTRUMENTS);
}

function getInstrumentInfo(symbol) {
  return INSTRUMENTS[symbol] || null;
}

function getBroker() {
  return broker;
}

async function getMarketStatus(symbol, opts = {}) {
  if (!broker) init({}, {});
  return broker.getMarketStatus(symbol, opts);
}

async function isMarketOpen(symbol, opts = {}) {
  const status = await getMarketStatus(symbol, opts);
  return !!status.isOpen;
}

module.exports = {
  init,
  setMode,
  tick,
  executionPrice,
  currentPrices,
  getSymbols,
  getInstrumentInfo,
  getBroker,
  getMarketStatus,
  isMarketOpen,
  INSTRUMENTS,
};
