'use strict';

/**
 * signals.js — Simple 4-Pillar Signal Engine
 *
 * 1. TREND:       Moving average alignment (EMA8 vs EMA21 vs EMA50)
 * 2. MOMENTUM:    RSI confirms direction (not overbought for longs, not oversold for shorts)
 * 3. LEVELS:      Price near support (buy) or resistance (sell)
 * 4. VOLUME:      Above-average volume confirms the move
 *
 * A trade fires when:
 *   - Trend is clear (EMAs aligned)
 *   - RSI confirms (not exhausted)
 *   - Price is near a key level
 *   - Volume backs it up
 *
 * Score: each pillar adds 1 point. Need >= 2 to trade.
 */

const logger = require('./logger');

// Runtime state
let weights = {};
let disabledSignals = {};
let consecutiveLosses = {};

function loadState(state) {
  if (state) {
    if (state.weights)           weights          = state.weights;
    if (state.disabledSignals)   disabledSignals   = state.disabledSignals;
    if (state.consecutiveLosses) consecutiveLosses = state.consecutiveLosses;
  }
}

function getState() {
  return { weights, disabledSignals, consecutiveLosses };
}

function disableSignal(key, durationMs) {
  disabledSignals[key] = Date.now() + durationMs;
}

function recordSignalLoss(key) {
  consecutiveLosses[key] = (consecutiveLosses[key] || 0) + 1;
}

function recordSignalWin(key) {
  consecutiveLosses[key] = 0;
}

function adjustWeight() {} // no-op for compatibility

// ─── Score one symbol ─────────────────────────────────────────────────────────
function score(ind, params, symbol = null) {
  if (!ind) return { direction: null, score: 0, reasons: [], activeSignals: 0, longScore: 0, shortScore: 0, sentimentScore: 0, blockedBySentiment: false };

  const { ema8, ema21, ema50, rsi7, close, support, resistance, volume, avgVolume } = ind;

  let longScore = 0;
  let shortScore = 0;
  const reasons = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // PILLAR 1: TREND — Moving Average Alignment
  // ═══════════════════════════════════════════════════════════════════════════
  if (ema8 && ema21) {
    // Bullish: price > EMA8 > EMA21
    if (close > ema8 && ema8 > ema21) {
      longScore += 1;
      reasons.push('trend:+1');
    }
    // Bearish: price < EMA8 < EMA21
    if (close < ema8 && ema8 < ema21) {
      shortScore += 1;
      reasons.push('trend:-1');
    }

    // Bonus: full stack with EMA50
    if (ema50) {
      if (close > ema8 && ema8 > ema21 && ema21 > ema50) {
        longScore += 0.5;
        reasons.push('trendStack:+0.5');
      }
      if (close < ema8 && ema8 < ema21 && ema21 < ema50) {
        shortScore += 0.5;
        reasons.push('trendStack:-0.5');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PILLAR 2: MOMENTUM — RSI Confirmation
  // ═══════════════════════════════════════════════════════════════════════════
  if (rsi7 !== null) {
    // For longs: RSI not overbought
    if (rsi7 < 75) {
      longScore += 1;
      reasons.push('rsiLong:+1');
    }
    // For shorts: RSI not oversold
    if (rsi7 > 25) {
      shortScore += 1;
      reasons.push('rsiShort:+1');
    }
    // RSI extremes — strong conviction for reversals
    if (rsi7 < 30) {
      longScore += 1;
      reasons.push('rsiOversold:+1');
    }
    if (rsi7 > 70) {
      shortScore += 1;
      reasons.push('rsiOverbought:+1');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PILLAR 3: LEVELS — Support & Resistance
  // ═══════════════════════════════════════════════════════════════════════════
  if (support && resistance && close) {
    const range = resistance - support;
    if (range > 0) {
      const posInRange = (close - support) / range; // 0 = at support, 1 = at resistance

      // Near support (bottom 30% of range) → buy signal
      if (posInRange <= 0.30) {
        longScore += 1;
        reasons.push('nearSupport:+1');
      }
      // Near resistance (top 30% of range) → sell signal
      if (posInRange >= 0.70) {
        shortScore += 1;
        reasons.push('nearResistance:+1');
      }
      // Breakout above resistance
      if (close > resistance) {
        longScore += 1;
        reasons.push('breakoutUp:+1');
      }
      // Breakdown below support
      if (close < support) {
        shortScore += 1;
        reasons.push('breakoutDown:+1');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PILLAR 4: VOLUME — Above-Average Confirms the Move
  // ═══════════════════════════════════════════════════════════════════════════
  if (volume && avgVolume && avgVolume > 0) {
    const volRatio = volume / avgVolume;
    if (volRatio >= 1.0) {
      // Volume confirms whichever direction is winning
      if (longScore > shortScore) {
        longScore += 1;
        reasons.push('volumeConfirm:+1');
      } else if (shortScore > longScore) {
        shortScore += 1;
        reasons.push('volumeConfirm:-1');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DECISION
  // ═══════════════════════════════════════════════════════════════════════════
  const netScore = longScore - shortScore;
  let direction = null;
  let finalScore = 0;

  if (netScore > 0) {
    direction = 'long';
    finalScore = netScore;
  } else if (netScore < 0) {
    direction = 'short';
    finalScore = Math.abs(netScore);
  }

  // Count pillars in winning direction
  const winningReasons = reasons.filter(r => {
    const val = r.split(':')[1];
    if (direction === 'long') return val && val.startsWith('+');
    if (direction === 'short') return val && val.startsWith('-');
    return false;
  });
  const activeSignals = new Set(winningReasons.map(r => r.split(':')[0])).size;

  return {
    direction,
    score:         parseFloat(finalScore.toFixed(2)),
    reasons,
    activeSignals,
    longScore:     parseFloat(longScore.toFixed(2)),
    shortScore:    parseFloat(shortScore.toFixed(2)),
    sentimentScore: 0,
    blockedBySentiment: false,
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
