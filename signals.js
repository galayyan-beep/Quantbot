'use strict';

/**
 * signals.js — Signal Scoring Engine.
 *
 * Each signal returns +score for LONG, -score for SHORT.
 * Weights are loaded from data/signals.json and can be adjusted at runtime
 * by the optimizer.
 *
 * Default weights (as specified in design doc):
 *   emaCross           +2 / -2
 *   vwapReclaim        +2 / -2
 *   momentumSurge      +2 / -2
 *   lowerBBWithRsi     +2 / -2
 *   macdCross          +1 / -1
 *   rsiBounce          +1 / -1
 *   bbSqueezeBreakout  +1 / -1
 *
 * A trade fires when abs(totalScore) >= params.minScore
 * AND at least 2 different signal keys contributed.
 */

const logger = require('./logger');
const sentiment = require('./sentiment');

// ─── Default weights ─────────────────────────────────────────────────────────
const DEFAULT_WEIGHTS = {
  emaCross:          2,
  vwapReclaim:       2,
  momentumSurge:     2,
  lowerBBWithRsi:    2,
  macdCross:         1,
  rsiBounce:         1,
  bbSqueezeBreakout: 1,
};

// Runtime state loaded/saved to signals.json
let weights        = { ...DEFAULT_WEIGHTS };
let disabledSignals = {};          // { signalKey: timestampUntilEnabled }
let consecutiveLosses = {};        // { signalKey: count }

function loadState(state) {
  if (state) {
    if (state.weights)           weights          = { ...DEFAULT_WEIGHTS, ...state.weights };
    if (state.disabledSignals)   disabledSignals   = state.disabledSignals;
    if (state.consecutiveLosses) consecutiveLosses = state.consecutiveLosses;
  }
}

function getState() {
  return { weights, disabledSignals, consecutiveLosses };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isSignalEnabled(key) {
  const until = disabledSignals[key];
  if (!until) return true;
  if (Date.now() > until) {
    delete disabledSignals[key];
    return true;
  }
  return false;
}

function disableSignal(key, durationMs) {
  disabledSignals[key] = Date.now() + durationMs;
  logger.warn('SIGNALS', `Signal disabled for ${Math.round(durationMs / 60000)}m`, { key });
}

function recordSignalLoss(key) {
  consecutiveLosses[key] = (consecutiveLosses[key] || 0) + 1;
  if (consecutiveLosses[key] >= 5) {
    disableSignal(key, 60 * 60 * 1000);  // 1 hour
    logger.warn('SIGNALS', `Signal auto-disabled after 5 consecutive losses`, { key });
    consecutiveLosses[key] = 0;
  }
}

function recordSignalWin(key) {
  consecutiveLosses[key] = 0;
}

function adjustWeight(key, delta) {
  if (weights[key] === undefined) return;
  const before = weights[key];
  weights[key] = Math.max(0.5, Math.min(4, weights[key] + delta));
  logger.optim('SIGNALS', `Weight adjusted`, { key, before, after: weights[key], delta });
}

// ─── Score one symbol ─────────────────────────────────────────────────────────
/**
 * @param {Object} ind     Result from indicators.calculateAll()
 * @param {Object} params  Trading parameters (rsiBuyLevel, rsiSellLevel, momentumThreshold, …)
 * @param {string} symbol  Symbol for sentiment overlay
 * @returns {{ direction: 'long'|'short'|null, score: number, reasons: string[] }}
 */
function score(ind, params, symbol = null) {
  if (!ind) return { direction: null, score: 0, reasons: [] };

  const {
    ema3, ema8, ema21, ema50,
    prevEma3, prevEma8,
    rsi7, prevRsi7,
    vwap, bb, prevBB,
    macd,
    momentum3,
    prevClose, close,
  } = ind;

  const rsiBuy  = params.rsiBuyLevel  || 28;
  const rsiSell = params.rsiSellLevel || 72;
  const momThr  = params.momentumThreshold || 0.003;

  let longScore  = 0;
  let shortScore = 0;
  const reasons  = [];

  // ── Signal 1: EMA3 crosses EMA8 while price is above/below EMA50 ───────────
  if (isSignalEnabled('emaCross') && ema3 && ema8 && ema50 && prevEma3 && prevEma8) {
    const w = weights.emaCross;
    if (prevEma3 <= prevEma8 && ema3 > ema8 && close > ema50) {
      longScore  += w;
      reasons.push('emaCross:+' + w);
    } else if (prevEma3 >= prevEma8 && ema3 < ema8 && close < ema50) {
      shortScore += w;
      reasons.push('emaCross:-' + w);
    }
  }

  // ── Signal 2: Price reclaims VWAP from below/above with RSI filter ─────────
  if (isSignalEnabled('vwapReclaim') && vwap && rsi7 !== null && prevClose !== null) {
    const w = weights.vwapReclaim;
    if (prevClose < vwap && close >= vwap && rsi7 < rsiSell) {
      longScore  += w;
      reasons.push('vwapReclaim:+' + w);
    } else if (prevClose > vwap && close <= vwap && rsi7 > rsiBuy) {
      shortScore += w;
      reasons.push('vwapReclaim:-' + w);
    }
  }

  // ── Signal 3: Momentum surge while on correct side of VWAP ────────────────
  if (isSignalEnabled('momentumSurge') && momentum3 !== null && vwap !== null) {
    const w = weights.momentumSurge;
    if (momentum3 >  momThr && close > vwap) {
      longScore  += w;
      reasons.push('momentumSurge:+' + w);
    } else if (momentum3 < -momThr && close < vwap) {
      shortScore += w;
      reasons.push('momentumSurge:-' + w);
    }
  }

  // ── Signal 4: Price touches lower/upper BB with RSI confirmation ───────────
  if (isSignalEnabled('lowerBBWithRsi') && bb && rsi7 !== null) {
    const w = weights.lowerBBWithRsi;
    if (close <= bb.lower && rsi7 < 32) {
      longScore  += w;
      reasons.push('lowerBBWithRsi:+' + w);
    } else if (close >= bb.upper && rsi7 > 68) {
      shortScore += w;
      reasons.push('upperBBWithRsi:-' + w);
    }
  }

  // ── Signal 5: MACD bullish/bearish crossover ───────────────────────────────
  if (isSignalEnabled('macdCross') && macd && macd.histogram !== null && macd.prevHistogram !== null) {
    const w = weights.macdCross;
    if (macd.prevHistogram <= 0 && macd.histogram > 0) {
      longScore  += w;
      reasons.push('macdCross:+' + w);
    } else if (macd.prevHistogram >= 0 && macd.histogram < 0) {
      shortScore += w;
      reasons.push('macdCross:-' + w);
    }
  }

  // ── Signal 6: RSI bounces above buy level / drops below sell level ─────────
  if (isSignalEnabled('rsiBounce') && rsi7 !== null && prevRsi7 !== null) {
    const w = weights.rsiBounce;
    if (prevRsi7 <= rsiBuy && rsi7 > rsiBuy) {
      longScore  += w;
      reasons.push('rsiBounce:+' + w);
    } else if (prevRsi7 >= rsiSell && rsi7 < rsiSell) {
      shortScore += w;
      reasons.push('rsiBounce:-' + w);
    }
  }

  // ── Signal 7: Bollinger Band squeeze breakout ──────────────────────────────
  if (isSignalEnabled('bbSqueezeBreakout') && bb && prevBB) {
    const w = weights.bbSqueezeBreakout;
    const squeezed  = prevBB.bandwidth < 0.015;  // tight bands
    const expanding = bb.bandwidth > prevBB.bandwidth * 1.05;
    if (squeezed && expanding) {
      if (close > bb.middle) {
        longScore  += w;
        reasons.push('bbSqueezeBreakout:+' + w);
      } else {
        shortScore += w;
        reasons.push('bbSqueezeBreakout:-' + w);
      }
    }
  }

  if (symbol) {
    const withBias = sentiment.applyBias(symbol, longScore, shortScore);
    longScore = withBias.longScore;
    shortScore = withBias.shortScore;
    if (withBias.sentimentScore > 2) reasons.push('sentimentBias:+1');
    if (withBias.sentimentScore < -2) reasons.push('sentimentBias:-1');
  }

  // ── Determine direction ────────────────────────────────────────────────────
  const netScore = longScore - shortScore;
  let direction  = null;
  let finalScore = 0;

  if (longScore > shortScore && longScore >= 1) {
    direction  = 'long';
    finalScore = longScore;
  } else if (shortScore > longScore && shortScore >= 1) {
    direction  = 'short';
    finalScore = shortScore;
  }

  // Count distinct signal keys that contributed
  const activeSignals = new Set(reasons.map(r => r.split(':')[0])).size;

  const blockedBySentiment = symbol && direction
    ? sentiment.blocksDirection(symbol, direction)
    : false;

  return {
    direction,
    score:         finalScore,
    reasons,
    activeSignals, // must be >= 2 to fire
    longScore,
    shortScore,
    sentimentScore: symbol ? sentiment.scoreFor(symbol) : 0,
    blockedBySentiment,
  };
}

module.exports = {
  score,
  loadState,
  getState,
  adjustWeight,
  disableSignal,
  recordSignalLoss,
  recordSignalWin,
  weights,
};
