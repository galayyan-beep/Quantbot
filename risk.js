'use strict';

/**
 * risk.js — Position sizing, stops, drawdown protection, and correlation guards.
 *
 * All sizing/stop calculations use ATR so the optimizer can adjust
 * atrMultiplier and riskPercent independently.
 */

const logger = require('./logger');
const { INSTRUMENTS } = require('./prices');

const MAX_TOTAL_EXPOSURE = 100;
const EXPOSURE_TOLERANCE_PCT = 0.02;
const MAX_TOTAL_EXPOSURE_WITH_TOLERANCE = MAX_TOTAL_EXPOSURE * (1 + EXPOSURE_TOLERANCE_PCT);

// ─── Correlation groups (never hold two from same group simultaneously) ───────
const CORRELATION_GROUPS = [
  new Set(['BTC', 'ETH', 'SOL', 'BNB']),
  new Set(['EURUSD', 'GBPUSD', 'AUDUSD']),
  new Set(['GOLD', 'SILVER']),
  new Set(['SPX', 'NQ', 'DAX']),
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Round to 8 significant decimals (handles both crypto and forex precision). */
function round8(n) {
  return parseFloat(n.toPrecision(8));
}

function positionExposure(position) {
  const entryPrice = Number(position?.entryPrice || 0);
  const size = Number(position?.size || 0);
  if (!Number.isFinite(entryPrice) || !Number.isFinite(size)) return 0;
  return Math.abs(entryPrice * size);
}

function totalOpenExposure(openPositions = {}) {
  let total = 0;
  for (const pos of Object.values(openPositions)) total += positionExposure(pos);
  return round8(total);
}

// ─── Correlation check ────────────────────────────────────────────────────────
/**
 * Returns true if symbol is correlated with any currently open position.
 */
function isCorrelated(symbol, openPositions) {
  const openSymbols = new Set(Object.keys(openPositions));
  for (const group of CORRELATION_GROUPS) {
    if (group.has(symbol)) {
      for (const open of openSymbols) {
        if (group.has(open) && open !== symbol) {
          return true;
        }
      }
    }
  }
  return false;
}

// ─── Position sizing ──────────────────────────────────────────────────────────
/**
 * Calculate position size based on risk percentage and ATR.
 *
 * Risk amount = capital × riskPercent / 100
 * Stop distance = atrMultiplierSL × atr
 * Position size (units) = riskAmount / stopDistance
 *
 * Additional caps:
 *  - Crypto: max 40% of capital as notional value
 *  - All: max 20% of capital total across all open positions
 *
 * @returns {{ size, stopLoss, takeProfit, riskAmount, notional } | null}
 */
function calcPositionSize(symbol, direction, entryPrice, atrValue, params, capital, openPositions) {
  if (!atrValue || atrValue <= 0 || !entryPrice || entryPrice <= 0) return null;

  const riskPct       = Math.min(params.riskPercent || 3, 3);
  const atrMulSL      = params.atrMultiplier     || 1.5;
  const atrMulTP      = atrMulSL * 2;            // 2 × SL for 2:1 R:R

  const riskAmount    = capital * riskPct / 100;
  const stopDistance  = atrMulSL * atrValue;
  const tpDistance    = atrMulTP * atrValue;

  let size = riskAmount / stopDistance;

  // ── Crypto hard cap: max 40% of capital in any single crypto position ──────
  const info = INSTRUMENTS[symbol];
  if (info && info.category === 'crypto') {
    const maxNotional = capital * 0.40;
    const candidateNotional = size * entryPrice;
    if (candidateNotional > maxNotional) {
      size = maxNotional / entryPrice;
    }
  }

  // ── Combined risk cap: never exceed 20% of capital across ALL positions ────
  let existingRisk = 0;
  for (const pos of Object.values(openPositions)) {
    existingRisk += pos.riskAmount || 0;
  }
  const maxNewRisk = capital * 0.20 - existingRisk;
  if (riskAmount > maxNewRisk) {
    if (maxNewRisk <= 0) return null;               // no room for more risk
    size = (maxNewRisk / stopDistance);
  }

  const existingExposure = totalOpenExposure(openPositions);
  const remainingExposure = MAX_TOTAL_EXPOSURE_WITH_TOLERANCE - existingExposure;
  if (remainingExposure <= 0) {
    logger.info('RISK', 'Trade rejected by total exposure cap', {
      symbol,
      currentExposure: round8(existingExposure),
      maxExposure: round8(MAX_TOTAL_EXPOSURE_WITH_TOLERANCE),
    });
    return null;
  }

  const candidateExposure = size * entryPrice;
  if (candidateExposure > remainingExposure) {
    size = remainingExposure / entryPrice;
  }

  size = round8(size);
  if (size <= 0) return null;

  const stopLoss   = direction === 'long'
    ? round8(entryPrice - stopDistance)
    : round8(entryPrice + stopDistance);

  const takeProfit = direction === 'long'
    ? round8(entryPrice + tpDistance)
    : round8(entryPrice - tpDistance);

  const notional   = round8(size * entryPrice);
  const actualRisk = round8(size * stopDistance);

  return { size, stopLoss, takeProfit, notional, riskAmount: actualRisk, stopDistance, tpDistance };
}

// ─── Trailing stop update ─────────────────────────────────────────────────────
/**
 * Advance the trailing stop only in the direction of profit.
 * Activates (tightens the follow) once price has moved ≥ 1× ATR in profit direction.
 *
 * @param {Object} position  Existing open position object
 * @param {number} currentPrice
 * @param {number} atrValue
 * @returns {number|null}    New trailing stop price, or null if not changed
 */
function updateTrailingStop(position, currentPrice, atrValue) {
  if (!atrValue) return null;

  const { direction, entryPrice, trailingStop, atrMultiplier: atrMul } = position;
  const mul = atrMul || 1.5;

  if (direction === 'long') {
    const newStop = round8(currentPrice - mul * atrValue);
    if (newStop > (trailingStop || position.stopLoss)) {
      return newStop;
    }
  } else {
    const newStop = round8(currentPrice + mul * atrValue);
    if (newStop < (trailingStop || position.stopLoss)) {
      return newStop;
    }
  }
  return null;
}

// ─── Drawdown calculation ─────────────────────────────────────────────────────
function calcDrawdown(capital, peakCapital) {
  if (!peakCapital || peakCapital <= 0) return 0;
  return (peakCapital - capital) / peakCapital;
}

// ─── Pre-trade guards ─────────────────────────────────────────────────────────
/**
 * Comprehensive pre-trade checks.
 * Returns { allowed: bool, reason: string }
 */
function preTradChecks({
  symbol,
  direction,
  openPositions,
  drawdown,
  params,
  cooldowns,
  recentLossBySymbol,   // { symbol: count of last-3 consecutive losses }
  winRateBuffer,         // rolling array of last 20 trade results (true=win)
  mode,                  // 'normal' | 'observation' | 'paused'
}) {
  // Hard pause states
  if (mode === 'paused') {
    return { allowed: false, reason: 'System paused – drawdown exceeded 12%' };
  }
  if (mode === 'observation') {
    return { allowed: false, reason: 'Observation mode active' };
  }

  // Max positions
  if (Object.keys(openPositions).length >= (params.maxPositions || 5)) {
    return { allowed: false, reason: 'Max positions reached' };
  }

  // No duplicate symbols
  if (openPositions[symbol]) {
    return { allowed: false, reason: 'Already have an open position in ' + symbol };
  }

  // Correlation guard
  if (isCorrelated(symbol, openPositions)) {
    return { allowed: false, reason: 'Correlated instrument already open' };
  }

  // Drawdown guards
  if (drawdown >= 0.12) {
    return { allowed: false, reason: 'Hard stop: drawdown ≥ 12%' };
  }

  // Symbol cooldown
  const cooldownUntil = cooldowns[symbol];
  if (cooldownUntil && Date.now() < cooldownUntil) {
    const secsLeft = Math.round((cooldownUntil - Date.now()) / 1000);
    return { allowed: false, reason: `${symbol} in cooldown (${secsLeft}s left)` };
  }

  // 3 consecutive losses on symbol → skip 30 candles
  const symLosses = recentLossBySymbol[symbol] || 0;
  if (symLosses >= 3) {
    return { allowed: false, reason: `${symbol} skipped: 3 consecutive losses` };
  }

  // Rolling 20-trade win-rate < 40% → observation mode (handled in index.js)
  if (winRateBuffer && winRateBuffer.length >= 20) {
    const wins = winRateBuffer.slice(-20).filter(Boolean).length;
    if (wins / 20 < 0.40) {
      return { allowed: false, reason: 'Win-rate below 40% — observation mode required' };
    }
  }

  return { allowed: true, reason: 'OK' };
}

module.exports = {
  MAX_TOTAL_EXPOSURE,
  MAX_TOTAL_EXPOSURE_WITH_TOLERANCE,
  EXPOSURE_TOLERANCE_PCT,
  calcPositionSize,
  updateTrailingStop,
  calcDrawdown,
  preTradChecks,
  isCorrelated,
  CORRELATION_GROUPS,
  positionExposure,
  totalOpenExposure,
};
