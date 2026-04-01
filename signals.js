'use strict';

/**
 * signals.js — Signal Scoring Engine (v2).
 *
 * Key improvements over v1:
 *  - Net scoring: opposing signals cancel out (long - short = final score)
 *  - Volume confirmation: signals require above-average volume to fire
 *  - Signal strength: partial scoring based on how strongly conditions are met
 *  - RSI mid-zone filter: avoid trading in the "dead zone" (RSI 40-60)
 *  - Only counts signals in the winning direction for activeSignals count
 */

const logger = require('./logger');
const sentiment = require('./sentiment');

// ─── Default weights (conservative for live trading) ─────────────────────────
const DEFAULT_WEIGHTS = {
  emaCross:          2.5,
  vwapReclaim:       2,
  momentumSurge:     2.5,
  lowerBBWithRsi:    2,
  macdCross:         1.5,
  rsiBounce:         1,
  bbSqueezeBreakout: 1.5,
  trendContinuation: 3,     // highest weight — most reliable signal
  cryptoBreakout:    2,
};

// Runtime state loaded/saved to signals.json
let weights        = { ...DEFAULT_WEIGHTS };
let disabledSignals = {};
let consecutiveLosses = {};

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
    disableSignal(key, 60 * 60 * 1000);
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

// ─── Volume confirmation helper ──────────────────────────────────────────────
/**
 * Check if current volume is above the recent average.
 * Returns a multiplier: 1.0 if vol is average, up to 1.3 for high volume,
 * and 0 if volume is too low (below 60% of average).
 */
function volumeStrength(ind) {
  if (!ind || !ind.volume || !ind.avgVolume) return 1.0; // no volume data, allow signal
  const ratio = ind.volume / Math.max(ind.avgVolume, 1);
  if (ratio < 0.6) return 0;     // too low volume, kill the signal
  if (ratio > 1.5) return 1.2;   // high volume, slight boost
  return 1.0;
}

// ─── Score one symbol ─────────────────────────────────────────────────────────
function score(ind, params, symbol = null) {
  if (!ind) return { direction: null, score: 0, reasons: [], activeSignals: 0, longScore: 0, shortScore: 0, sentimentScore: 0, blockedBySentiment: false };

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
  const volMul = volumeStrength(ind);

  // ── RSI dead zone penalty: if RSI is 42-58, reduce all signal weights ──────
  const rsiPenalty = (rsi7 !== null && rsi7 > 42 && rsi7 < 58) ? 0.6 : 1.0;

  // ── Signal 1: EMA3 crosses EMA8 with price on correct side of EMA50 ───────
  if (isSignalEnabled('emaCross') && ema3 && ema8 && ema50 && prevEma3 && prevEma8) {
    const w = weights.emaCross * rsiPenalty * volMul;
    if (w > 0) {
      if (prevEma3 <= prevEma8 && ema3 > ema8 && close > ema50) {
        longScore  += w;
        reasons.push('emaCross:+' + w.toFixed(1));
      } else if (prevEma3 >= prevEma8 && ema3 < ema8 && close < ema50) {
        shortScore += w;
        reasons.push('emaCross:-' + w.toFixed(1));
      }
    }
  }

  // ── Signal 2: VWAP reclaim with RSI filter ─────────────────────────────────
  if (isSignalEnabled('vwapReclaim') && vwap && rsi7 !== null && prevClose !== null) {
    const w = weights.vwapReclaim * rsiPenalty * volMul;
    if (w > 0) {
      if (prevClose < vwap && close >= vwap && rsi7 < rsiSell) {
        longScore  += w;
        reasons.push('vwapReclaim:+' + w.toFixed(1));
      } else if (prevClose > vwap && close <= vwap && rsi7 > rsiBuy) {
        shortScore += w;
        reasons.push('vwapReclaim:-' + w.toFixed(1));
      }
    }
  }

  // ── Signal 3: Momentum surge on correct side of VWAP ──────────────────────
  if (isSignalEnabled('momentumSurge') && momentum3 !== null && vwap !== null) {
    const w = weights.momentumSurge * volMul;
    // Scale by how far momentum exceeds threshold (stronger = higher score)
    if (momentum3 > momThr && close > vwap) {
      const strength = Math.min(2.0, momentum3 / momThr); // up to 2x for very strong momentum
      longScore  += w * strength;
      reasons.push('momentumSurge:+' + (w * strength).toFixed(1));
    } else if (momentum3 < -momThr && close < vwap) {
      const strength = Math.min(2.0, Math.abs(momentum3) / momThr);
      shortScore += w * strength;
      reasons.push('momentumSurge:-' + (w * strength).toFixed(1));
    }
  }

  // ── Signal 4: Bollinger Band mean reversion with RSI confirmation ──────────
  if (isSignalEnabled('lowerBBWithRsi') && bb && rsi7 !== null) {
    const w = weights.lowerBBWithRsi * volMul;
    if (w > 0) {
      if (close <= bb.lower && rsi7 < 32) {
        longScore  += w;
        reasons.push('lowerBBWithRsi:+' + w.toFixed(1));
      } else if (close >= bb.upper && rsi7 > 68) {
        shortScore += w;
        reasons.push('upperBBWithRsi:-' + w.toFixed(1));
      }
    }
  }

  // ── Signal 5: MACD histogram crossover ─────────────────────────────────────
  if (isSignalEnabled('macdCross') && macd && macd.histogram !== null && macd.prevHistogram !== null) {
    const w = weights.macdCross * rsiPenalty * volMul;
    if (w > 0) {
      if (macd.prevHistogram <= 0 && macd.histogram > 0) {
        longScore  += w;
        reasons.push('macdCross:+' + w.toFixed(1));
      } else if (macd.prevHistogram >= 0 && macd.histogram < 0) {
        shortScore += w;
        reasons.push('macdCross:-' + w.toFixed(1));
      }
    }
  }

  // ── Signal 6: RSI bounce from extremes ─────────────────────────────────────
  if (isSignalEnabled('rsiBounce') && rsi7 !== null && prevRsi7 !== null) {
    const w = weights.rsiBounce * volMul;
    if (w > 0) {
      if (prevRsi7 <= rsiBuy && rsi7 > rsiBuy) {
        longScore  += w;
        reasons.push('rsiBounce:+' + w.toFixed(1));
      } else if (prevRsi7 >= rsiSell && rsi7 < rsiSell) {
        shortScore += w;
        reasons.push('rsiBounce:-' + w.toFixed(1));
      }
    }
  }

  // ── Signal 7: Bollinger Band squeeze breakout ──────────────────────────────
  if (isSignalEnabled('bbSqueezeBreakout') && bb && prevBB) {
    const w = weights.bbSqueezeBreakout * volMul;
    const squeezed  = prevBB.bandwidth < 0.015;
    const expanding = bb.bandwidth > prevBB.bandwidth * 1.08;  // stricter: was 1.05
    if (w > 0 && squeezed && expanding) {
      // Require price to be clearly above/below middle band, not just barely
      if (close > bb.middle + (bb.upper - bb.middle) * 0.3) {
        longScore  += w;
        reasons.push('bbSqueezeBreakout:+' + w.toFixed(1));
      } else if (close < bb.middle - (bb.middle - bb.lower) * 0.3) {
        shortScore += w;
        reasons.push('bbSqueezeBreakout:-' + w.toFixed(1));
      }
    }
  }

  // ── Signal 8: Trend continuation (MOST RELIABLE — highest weight) ──────────
  if (isSignalEnabled('trendContinuation') && ema8 && ema21 && ema50 && rsi7 !== null && momentum3 !== null && close) {
    const w = weights.trendContinuation * volMul;
    if (w > 0) {
      const emaStackBull = close > ema8 && ema8 > ema21 && ema21 > ema50;
      const emaStackBear = close < ema8 && ema8 < ema21 && ema21 < ema50;
      // RSI should be in healthy range (not overbought/oversold) for continuation
      if (emaStackBull && rsi7 >= 50 && rsi7 <= 68 && momentum3 > momThr * 0.5) {
        longScore += w;
        reasons.push('trendContinuation:+' + w.toFixed(1));
      } else if (emaStackBear && rsi7 <= 50 && rsi7 >= 32 && momentum3 < -momThr * 0.5) {
        shortScore += w;
        reasons.push('trendContinuation:-' + w.toFixed(1));
      }
    }
  }

  // ── Signal 9: Crypto breakout ──────────────────────────────────────────────
  if (symbol && ['BTC', 'ETH', 'SOL', 'BNB'].includes(symbol) && isSignalEnabled('cryptoBreakout') && bb && prevBB && ema8 && ema21 && momentum3 !== null && close) {
    const w = weights.cryptoBreakout * volMul;
    if (w > 0) {
      const bandExpansion = bb.bandwidth > prevBB.bandwidth * 1.1;  // stricter: was 1.08
      const bullishBreakout = bandExpansion && close > bb.upper * 0.998 && ema8 > ema21 && momentum3 > momThr * 0.8;
      const bearishBreakout = bandExpansion && close < bb.lower * 1.002 && ema8 < ema21 && momentum3 < -momThr * 0.8;
      if (bullishBreakout) {
        longScore += w;
        reasons.push('cryptoBreakout:+' + w.toFixed(1));
      } else if (bearishBreakout) {
        shortScore += w;
        reasons.push('cryptoBreakout:-' + w.toFixed(1));
      }
    }
  }

  // ── Sentiment overlay ──────────────────────────────────────────────────────
  if (symbol) {
    const withBias = sentiment.applyBias(symbol, longScore, shortScore);
    longScore = withBias.longScore;
    shortScore = withBias.shortScore;
    if (withBias.sentimentScore > 2) reasons.push('sentimentBias:+1');
    if (withBias.sentimentScore < -2) reasons.push('sentimentBias:-1');
  }

  // ── Determine direction using NET score ────────────────────────────────────
  const netScore = longScore - shortScore;
  let direction  = null;
  let finalScore = 0;

  if (netScore > 0) {
    direction  = 'long';
    finalScore = netScore;
  } else if (netScore < 0) {
    direction  = 'short';
    finalScore = Math.abs(netScore);
  }

  // Count distinct signal keys in winning direction only
  const winningReasons = reasons.filter(r => {
    const val = r.split(':')[1];
    if (direction === 'long') return val && val.startsWith('+');
    if (direction === 'short') return val && val.startsWith('-');
    return false;
  });
  const activeSignals = new Set(winningReasons.map(r => r.split(':')[0])).size;

  const blockedBySentiment = symbol && direction
    ? sentiment.blocksDirection(symbol, direction)
    : false;

  return {
    direction,
    score:         parseFloat(finalScore.toFixed(2)),
    reasons,
    activeSignals,
    longScore:     parseFloat(longScore.toFixed(2)),
    shortScore:    parseFloat(shortScore.toFixed(2)),
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
