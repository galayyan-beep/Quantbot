'use strict';

/**
 * memory.js — Market-condition memory and pattern matching.
 *
 * Maintains a rolling window of the last 500 closed trades, each enriched
 * with a "market fingerprint" snapshot taken at entry time.
 *
 * Before any new trade is opened, the fingerprint of current conditions is
 * compared against the stored memory; if historically similar conditions
 * produced losses > 60% of the time, the trade is skipped.
 *
 * Every 100 trades the full memory is sent to the Anthropic API for a
 * deep performance reflection (handled by optimizer.js Layer 4).
 */

const logger = require('./logger');

const MAX_MEMORY    = 500;
const BAD_WIN_RATE  = 0.40;        // skip trade if similar conditions lost > 60%
const MIN_SAMPLES   = 5;           // need at least 5 similar trades to act on the data
const BEST_WEIGHT   = 1.30;        // boost size 30% in best condition
const WORST_WEIGHT  = 0.50;        // halve size in worst condition

// In-memory rolling trade memory
let memory = [];

// AI-derived condition weights injected by Layer-4 analysis
let conditionWeights = {};        // { conditionKey: multiplier }

// ─── Init ─────────────────────────────────────────────────────────────────────
function init(savedMemory = [], savedWeights = {}) {
  memory           = savedMemory.slice(-MAX_MEMORY);
  conditionWeights = savedWeights;
}

// ─── Market fingerprint ───────────────────────────────────────────────────────
/**
 * Reduce continuous indicator values to a discrete "fingerprint" string
 * that can be matched against historical memory.
 *
 * Dimensions:
 *   trend      : bull | bear | neutral
 *   rsiZone    : oversold | neutral | overbought
 *   vwapSide   : above | below
 *   volRegime  : low | normal | high    (based on BB bandwidth)
 *   hourBlock  : 0-3 | 4-7 | 8-11 | 12-15 | 16-19 | 20-23   (UTC)
 */
function fingerprint(ind, symbol) {
  if (!ind) return null;

  const { ema21, ema50, rsi7, vwap, bb, close } = ind;

  const trend = ema21 && ema50
    ? (ema21 > ema50 ? 'bull' : ema21 < ema50 ? 'bear' : 'neutral')
    : 'neutral';

  const rsiZone = rsi7 === null ? 'neutral'
    : rsi7 < 35  ? 'oversold'
    : rsi7 > 65  ? 'overbought'
    : 'neutral';

  const vwapSide = vwap && close
    ? (close > vwap ? 'above' : 'below')
    : 'unknown';

  const volRegime = bb
    ? (bb.bandwidth < 0.010 ? 'low'
      : bb.bandwidth > 0.030 ? 'high'
      : 'normal')
    : 'normal';

  const hour = new Date().getUTCHours();
  const hourBlock = `h${Math.floor(hour / 4) * 4}`;

  return `${symbol}|${trend}|${rsiZone}|${vwapSide}|${volRegime}|${hourBlock}`;
}

// ─── Pre-trade memory check ───────────────────────────────────────────────────
/**
 * Check historical memory for the given fingerprint.
 * Returns { skip: bool, reason: string, winRate: number }
 */
function checkCondition(fp) {
  if (!fp) return { skip: false, reason: 'No fingerprint' };

  const matches = memory.filter(m => m.fingerprint === fp);
  if (matches.length < MIN_SAMPLES) {
    return { skip: false, reason: `Insufficient history (${matches.length} samples)`, winRate: null };
  }

  const wins    = matches.filter(m => m.isWin).length;
  const winRate = wins / matches.length;

  if (winRate < BAD_WIN_RATE) {
    return {
      skip:    true,
      reason:  `Memory skip: ${(winRate * 100).toFixed(0)}% win rate in similar conditions (need ≥${BAD_WIN_RATE * 100}%)`,
      winRate,
      samples: matches.length,
    };
  }

  return { skip: false, reason: 'OK', winRate, samples: matches.length };
}

// ─── Record a closed trade into memory ────────────────────────────────────────
function recordTrade(trade, fp) {
  const entry = {
    id:          trade.id,
    symbol:      trade.symbol,
    direction:   trade.direction,
    entryTime:   trade.entryTime,
    fingerprint: fp,
    isWin:       trade.isWin,
    pnl:         trade.pnl,
    reasons:     trade.reasons,
  };

  memory.push(entry);
  if (memory.length > MAX_MEMORY) memory.shift();

  logger.writeJSON('memory.json', { entries: memory, conditionWeights });
}

// ─── Size multiplier from condition weights ───────────────────────────────────
/**
 * Returns a position-size multiplier based on AI-identified best/worst conditions.
 * Normal = 1.0, best = 1.3, worst = 0.5
 */
function sizeMultiplier(fp) {
  return conditionWeights[fp] || 1.0;
}

// ─── Apply Layer-4 AI findings ────────────────────────────────────────────────
function applyConditionWeights(best, worst) {
  if (best)  conditionWeights[best]  = BEST_WEIGHT;
  if (worst) conditionWeights[worst] = WORST_WEIGHT;
  logger.optim('MEMORY', 'Condition weights updated', { best, worst });
  logger.writeJSON('memory.json', { entries: memory, conditionWeights });
}

function getMemory()            { return memory; }
function getConditionWeights()  { return conditionWeights; }

module.exports = {
  init,
  fingerprint,
  checkCondition,
  recordTrade,
  sizeMultiplier,
  applyConditionWeights,
  getMemory,
  getConditionWeights,
};
