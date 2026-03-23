'use strict';

/**
 * executor.js — Trade entry, exit, and position lifecycle management.
 *
 * All trades are paper-executed at the simulated bid/ask price from prices.js.
 * Every opened and closed trade is recorded to data/trades.json.
 */

const logger   = require('./logger');
const prices   = require('./prices');
const signals  = require('./signals');

function shouldLiveExecute() {
  return process.env.LIVE_TRADING === 'true' && !_state.PAPER_TRADING;
}

function registerSetupOutcome(position, closedTrade) {
  const setupKey = position?.setupKey;
  if (!setupKey || !_state) return;

  if (!_state.setupStopoutCounts) _state.setupStopoutCounts = {};
  if (!_state.setupCooldowns) _state.setupCooldowns = {};

  const isFastStopout = closedTrade.exitReason === 'stop_loss' && Number(closedTrade.holdCandles || 0) <= 1;
  if (isFastStopout) {
    const nextCount = Number(_state.setupStopoutCounts[setupKey] || 0) + 1;
    _state.setupStopoutCounts[setupKey] = nextCount;
    if (nextCount >= 2) {
      _state.setupCooldowns[setupKey] = Date.now() + 90 * 60 * 1000;
      _state.setupStopoutCounts[setupKey] = 0;
      logger.warn('EXECUTOR', 'Setup cooled down after repeated one-candle stop-outs', { setupKey, cooldownMinutes: 90 });
    }
    return;
  }

  if (closedTrade.isWin) {
    _state.setupStopoutCounts[setupKey] = 0;
    delete _state.setupCooldowns[setupKey];
  }
}

// ─── Runtime state (injected from index.js via init) ─────────────────────────
let _state       = null;   // shared mutable state object
let _tradeLog    = [];     // in-memory copy of all trades

// ─── Init ─────────────────────────────────────────────────────────────────────
function init(sharedState, savedTrades = []) {
  _state    = sharedState;
  _tradeLog = savedTrades;
}

// ─── Enter a trade ────────────────────────────────────────────────────────────
/**
 * Open a new position.
 *
 * @param {string}  symbol
 * @param {'long'|'short'} direction
 * @param {number}  size         Units to buy/sell
 * @param {number}  stopLoss
 * @param {number}  takeProfit
 * @param {number}  riskAmount   Capital at risk
 * @param {string[]} reasons     Signal reasons that triggered this trade
 * @param {number} sentimentScore Sentiment snapshot at entry
 * @returns {Object} position object
 */
function enter(symbol, direction, size, stopLoss, takeProfit, riskAmount, reasons, sentimentScore = 0) {
  // Never allow dual-sided exposure on same symbol.
  // If opposite direction exists, close it first, then proceed.
  const existingPos = _state.openPositions[symbol];
  if (existingPos) {
    if (existingPos.direction === direction) {
      logger.warn('EXECUTOR', 'Entry blocked: position already exists', { symbol, direction });
      return null;
    }

    logger.warn('EXECUTOR', 'Opposite position detected, closing before reverse entry', {
      symbol,
      attemptedDirection: direction,
      existingDirection: existingPos.direction,
      existingEntryPrice: existingPos.entryPrice,
    });

    const closed = exit(symbol, 'signal_reverse');
    if (!closed) {
      logger.error('EXECUTOR', 'Entry blocked: failed to close opposite position before reverse', {
        symbol,
        attemptedDirection: direction,
        existingDirection: existingPos.direction,
      });
      return null;
    }
  }

  const side         = direction === 'long' ? 'buy' : 'sell';
  const entryPrice   = prices.executionPrice(symbol, side);
  const now          = Date.now();
  const tradeId      = `${symbol}-${now}`;

  const position = {
    id:           tradeId,
    symbol,
    direction,
    entryPrice,
    entryTime:    now,
    size,
    stopLoss,
    takeProfit,
    trailingStop: stopLoss,   // starts equal to stop loss, only moves in profit direction
    riskAmount,
    candleCount:  0,          // incremented on each tick
    reasons,
    sentimentScore,
    status:       'open',
    brokerDealId: null,
    brokerDealReference: null,
  };

  _state.openPositions[symbol] = position;
  _state.capital               -= 0;   // paper: no capital locked, just tracked notionally

  logger.trade('EXECUTOR', `ENTER ${direction.toUpperCase()} ${symbol}`, {
    price:  entryPrice,
    size,
    sl:     stopLoss,
    tp:     takeProfit,
    risk:   riskAmount.toFixed(2),
    score:  reasons.join(', '),
    sentimentScore,
  });

  if (shouldLiveExecute()) {
    const broker = prices.getBroker();
    if (broker) {
      broker.placePosition({ symbol, direction, size, stopLoss, takeProfit })
        .then(res => {
          position.brokerDealId = res?.dealId || null;
          position.brokerDealReference = res?.dealReference || null;
          logger.trade('EXECUTOR', 'Live order submitted', { symbol, dealId: position.brokerDealId, dealReference: position.brokerDealReference });
        })
        .catch(err => logger.error('EXECUTOR', 'Live order submission failed', { symbol, error: err.message }));
    }
  }

  return position;
}

// ─── Exit a trade ─────────────────────────────────────────────────────────────
/**
 * Close an existing position by symbol.
 *
 * @param {string} symbol
 * @param {string} exitReason  'stop_loss' | 'take_profit' | 'signal_reverse' | 'trailing_stop' | 'manual'
 * @param {number} [overridePrice]  If provided, use this as exit price (e.g., exact SL)
 * @returns {Object|null}  Closed trade record
 */
function exit(symbol, exitReason, overridePrice) {
  const position = _state.openPositions[symbol];
  if (!position) {
    logger.warn('EXECUTOR', `Tried to exit ${symbol} but no open position found`);
    return null;
  }

  const side      = position.direction === 'long' ? 'sell' : 'buy';
  const exitPrice = overridePrice !== undefined
    ? overridePrice
    : prices.executionPrice(symbol, side);

  const priceDiff = position.direction === 'long'
    ? exitPrice - position.entryPrice
    : position.entryPrice - exitPrice;

  const pnl         = priceDiff * position.size;
  const pnlPct      = priceDiff / position.entryPrice;
  const holdCandles = position.candleCount;
  const now         = Date.now();
  const isWin       = pnl > 0;

  // Update capital
  _state.capital += pnl;
  if (_state.capital > _state.peakCapital) {
    _state.peakCapital = _state.capital;
  }

  // Build closed trade record
  const closedTrade = {
    ...position,
    exitPrice,
    exitTime:   now,
    exitReason,
    pnl:        parseFloat(pnl.toFixed(4)),
    pnlPct:     parseFloat(pnlPct.toFixed(6)),
    holdCandles,
    isWin,
    status:     'closed',
  };

  // Remove from open positions
  delete _state.openPositions[symbol];

  // Append to trade log
  _tradeLog.push(closedTrade);
  logger.writeJSON('trades.json', _tradeLog);

  // Update cooldown (symbol-level, candle-based handled in index.js)
  const cooldownMs = ((_state.params.cooldownCandles || 10) * 2) * 1000;
  _state.cooldowns[symbol] = now + cooldownMs;

  // Update consecutive loss tracking
  if (!isWin) {
    _state.recentLossBySymbol[symbol] = (_state.recentLossBySymbol[symbol] || 0) + 1;
  } else {
    _state.recentLossBySymbol[symbol] = 0;
    // Reset after 30-candle penalty if 3 consecutive losses were cleared by a win
  }

  // Update rolling win rate buffer
  _state.winRateBuffer.push(isWin);
  if (_state.winRateBuffer.length > 20) _state.winRateBuffer.shift();

  // Update signal loss/win tracking for optimizer
  for (const reason of (position.reasons || [])) {
    const key = reason.split(':')[0];
    if (isWin) signals.recordSignalWin(key);
    else        signals.recordSignalLoss(key);
  }

  registerSetupOutcome(position, closedTrade);

  logger.trade('EXECUTOR', `EXIT ${exitReason.toUpperCase()} ${symbol}`, {
    entry:    position.entryPrice,
    exit:     exitPrice,
    pnl:      pnl.toFixed(2),
    pnlPct:   (pnlPct * 100).toFixed(3) + '%',
    candles:  holdCandles,
    capital:  _state.capital.toFixed(2),
  });

  if (shouldLiveExecute() && position.brokerDealId) {
    const broker = prices.getBroker();
    if (broker) {
      broker.closePosition(position.brokerDealId)
        .then(() => logger.trade('EXECUTOR', 'Live position closed', { symbol, dealId: position.brokerDealId }))
        .catch(err => logger.error('EXECUTOR', 'Live position close failed', { symbol, dealId: position.brokerDealId, error: err.message }));
    }
  }

  return closedTrade;
}

// ─── Check exit conditions for all open positions ─────────────────────────────
/**
 * Called every tick. Evaluates SL, TP, trailing stop, and signal reversal
 * for each open position.
 *
 * @param {Object} currentCandles  { symbol: { close, high, low } }
 * @param {Object} indicatorsMap   { symbol: indicatorResult }
 * @param {Object} params
 */
function checkExits(currentCandles, indicatorsMap, params) {
  const minHold = params.minHoldCandles || 5;

  for (const [symbol, pos] of Object.entries(_state.openPositions)) {
    const candle = currentCandles[symbol];
    if (!candle) continue;

    // Increment candle counter
    pos.candleCount += 1;

    const { high, low, close } = candle;
    const ind = indicatorsMap[symbol];

    // ── Hard stop loss hit? ────────────────────────────────────────────────
    if (pos.direction === 'long' && low <= pos.stopLoss) {
      exit(symbol, 'stop_loss', pos.stopLoss);
      continue;
    }
    if (pos.direction === 'short' && high >= pos.stopLoss) {
      exit(symbol, 'stop_loss', pos.stopLoss);
      continue;
    }

    // ── Take profit hit? ───────────────────────────────────────────────────
    if (pos.direction === 'long' && high >= pos.takeProfit) {
      exit(symbol, 'take_profit', pos.takeProfit);
      continue;
    }
    if (pos.direction === 'short' && low <= pos.takeProfit) {
      exit(symbol, 'take_profit', pos.takeProfit);
      continue;
    }

    // ── Trailing stop hit? ─────────────────────────────────────────────────
    if (pos.trailingStop !== pos.stopLoss) {   // trailing has moved
      if (pos.direction === 'long' && low <= pos.trailingStop) {
        exit(symbol, 'trailing_stop', pos.trailingStop);
        continue;
      }
      if (pos.direction === 'short' && high >= pos.trailingStop) {
        exit(symbol, 'trailing_stop', pos.trailingStop);
        continue;
      }
    }

    // ── Signal reversal exit (only after minimum hold) ─────────────────────
    if (pos.candleCount >= minHold && ind) {
      const sig = signals.score(ind, params);
      const rev = pos.direction === 'long'
        ? (sig.direction === 'short' && sig.score >= params.minScore)
        : (sig.direction === 'long'  && sig.score >= params.minScore);

      if (rev) {
        exit(symbol, 'signal_reverse');
        continue;
      }
    }
  }
}

function getTradeLog() {
  return _tradeLog;
}

module.exports = { init, enter, exit, checkExits, getTradeLog };
