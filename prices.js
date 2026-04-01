'use strict';

const logger = require('./logger');
const { CapitalClient } = require('./capitalApi');
const { INSTRUMENTS } = require('./config');

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

function getCachedMarketStatus(symbol) {
  if (!broker) return null;
  if (typeof broker.getCachedMarketStatus === 'function') {
    return broker.getCachedMarketStatus(symbol);
  }
  return null;
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
  getCachedMarketStatus,
  getMarketStatus,
  isMarketOpen,
  INSTRUMENTS,
};
