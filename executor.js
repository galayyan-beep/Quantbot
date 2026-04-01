'use strict';

/**
 * executor.js — Trade entry, exit, and position lifecycle management (v2).
 *
 * Improvements over v1:
 *  - Partial take-profit: close 50% at 2× ATR profit, let rest run to full TP
 *  - Break-even stop: move stop to entry price once 1.5× ATR profit reached
 *  - Time-based exit: close positions held too long (>60 candles) with no profit
 *  - Async enter() with broker verification
 *  - Loss cooldown with auto-recovery
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

// ─── Runtime state ───────────────────────────────────────────────────────────
let _state       = null;
let _tradeLog    = [];

function init(sharedState, savedTrades = []) {
  _state    = sharedState;
  _tradeLog = savedTrades;
}

// ─── Enter a trade ───────────────────────────────────────────────────────────
async function enter(symbol, direction, size, stopLoss, takeProfit, riskAmount, reasons, sentimentScore = 0) {
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
    });

    const closed = exit(symbol, 'signal_reverse');
    if (!closed) {
      logger.error('EXECUTOR', 'Entry blocked: failed to close opposite position', { symbol });
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
    originalSize: size,       // Track original for partial TP
    stopLoss,
    takeProfit,
    trailingStop: stopLoss,
    riskAmount,
    candleCount:  0,
    reasons,
    sentimentScore,
    status:       'open',
    brokerDealId: null,
    brokerDealReference: null,
    brokerConfirmed: false,
    partialTpTaken: false,    // Has 50% been closed at 2× ATR?
    breakEvenSet:  false,     // Has stop been moved to entry?
  };

  _state.openPositions[symbol] = position;

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
      try {
        const res = await broker.placePosition({ symbol, direction, size, stopLoss, takeProfit });
        position.brokerDealId = res?.dealId || null;
        position.brokerDealReference = res?.dealReference || null;
        logger.trade('EXECUTOR', 'Live order submitted', { symbol, dealId: position.brokerDealId });

        if (broker.getOpenPositions) {
          try {
            const livePositions = await broker.getOpenPositions();
            const confirmed = (livePositions?.positions || []).some(
              p => p.dealId === position.brokerDealId || p.market?.epic?.includes(symbol)
            );
            position.brokerConfirmed = !!confirmed;
            if (!confirmed) {
              logger.warn('EXECUTOR', 'Live order not confirmed — may be pending', { symbol });
            }
          } catch (verifyErr) {
            logger.warn('EXECUTOR', 'Position verification failed', { symbol, error: verifyErr.message });
          }
        }
      } catch (err) {
        logger.error('EXECUTOR', 'Live order failed — rolling back', { symbol, error: err.message });
        delete _state.openPositions[symbol];
        return null;
      }
    }
  }

  return position;
}

// ─── Exit a trade ────────────────────────────────────────────────────────────
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

  _state.capital += pnl;
  if (_state.capital > _state.peakCapital) {
    _state.peakCapital = _state.capital;
  }

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

  delete _state.openPositions[symbol];

  _tradeLog.push(closedTrade);
  logger.writeJSON('trades.json', _tradeLog);

  // Cooldown (candle-based)
  const cooldownMs = ((_state.params.cooldownCandles || 10) * 2) * 1000;
  _state.cooldowns[symbol] = now + cooldownMs;

  // Consecutive loss tracking with time-based recovery
  if (!isWin) {
    const newCount = (_state.recentLossBySymbol[symbol] || 0) + 1;
    _state.recentLossBySymbol[symbol] = newCount;
    if (newCount >= 3) {
      _state.cooldowns[symbol + '_loss_cooldown'] = now + 30 * 60 * 1000;
      _state.recentLossBySymbol[symbol] = 0;
      logger.trade('EXECUTOR', `${symbol}: 3 consecutive losses — 30min cooldown`, { symbol });
    }
  } else {
    _state.recentLossBySymbol[symbol] = 0;
    delete _state.cooldowns[symbol + '_loss_cooldown'];
  }

  // Rolling win rate buffer
  _state.winRateBuffer.push(isWin);
  if (_state.winRateBuffer.length > 20) _state.winRateBuffer.shift();

  // Signal loss/win tracking
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
        .then(() => logger.trade('EXECUTOR', 'Live position closed', { symbol }))
        .catch(err => logger.error('EXECUTOR', 'Live position close failed', { symbol, error: err.message }));
    }
  }

  return closedTrade;
}

// ─── Partial take-profit: close 50% at 2× ATR ───────────────────────────────
function checkPartialTP(pos, currentPrice, atrValue) {
  if (!atrValue || pos.partialTpTaken) return;

  const profitDistance = pos.direction === 'long'
    ? currentPrice - pos.entryPrice
    : pos.entryPrice - currentPrice;

  // At 2× ATR profit, take 50% off the table
  if (profitDistance >= 2.0 * atrValue) {
    const halfSize = pos.originalSize * 0.5;
    const pnl = profitDistance * halfSize;

    pos.size = pos.size - halfSize;
    pos.partialTpTaken = true;
    _state.capital += pnl;

    if (_state.capital > _state.peakCapital) {
      _state.peakCapital = _state.capital;
    }

    logger.trade('EXECUTOR', `PARTIAL TP ${pos.symbol} — closed 50% at 2×ATR`, {
      symbol: pos.symbol,
      pnl: pnl.toFixed(2),
      remainingSize: pos.size.toFixed(6),
      profitDistance: profitDistance.toFixed(4),
    });
  }
}

// ─── Break-even stop: move stop to entry after 1.5× ATR profit ──────────────
function checkBreakEven(pos, currentPrice, atrValue) {
  if (!atrValue || pos.breakEvenSet) return;

  const profitDistance = pos.direction === 'long'
    ? currentPrice - pos.entryPrice
    : pos.entryPrice - currentPrice;

  if (profitDistance >= 1.5 * atrValue) {
    // Move stop to entry + small buffer (0.2× ATR to account for spread)
    const buffer = 0.2 * atrValue;
    const newStop = pos.direction === 'long'
      ? pos.entryPrice + buffer
      : pos.entryPrice - buffer;

    if (pos.direction === 'long' && newStop > pos.stopLoss) {
      pos.stopLoss = newStop;
      pos.trailingStop = Math.max(pos.trailingStop, newStop);
      pos.breakEvenSet = true;
      logger.trade('EXECUTOR', `BREAK-EVEN ${pos.symbol} — stop moved to entry`, {
        symbol: pos.symbol,
        newStop: newStop.toFixed(4),
      });
    } else if (pos.direction === 'short' && newStop < pos.stopLoss) {
      pos.stopLoss = newStop;
      pos.trailingStop = Math.min(pos.trailingStop, newStop);
      pos.breakEvenSet = true;
      logger.trade('EXECUTOR', `BREAK-EVEN ${pos.symbol} — stop moved to entry`, {
        symbol: pos.symbol,
        newStop: newStop.toFixed(4),
      });
    }
  }
}

// ─── Check exits for all open positions ──────────────────────────────────────
function checkExits(currentCandles, indicatorsMap, params) {
  const minHold = params.minHoldCandles || 5;

  for (const [symbol, pos] of Object.entries(_state.openPositions)) {
    const candle = currentCandles[symbol];
    if (!candle) continue;

    pos.candleCount += 1;
    pos.lastPrice = candle.close;  // Track for drawdown checks

    const { high, low, close } = candle;
    const ind = indicatorsMap[symbol];
    const atrValue = ind?.atr7 || null;

    // ── Partial take-profit check ─────────────────────────────────────────
    if (atrValue) {
      checkPartialTP(pos, close, atrValue);
      checkBreakEven(pos, close, atrValue);
    }

    // ── Hard stop loss hit? ───────────────────────────────────────────────
    if (pos.direction === 'long' && low <= pos.stopLoss) {
      exit(symbol, 'stop_loss', pos.stopLoss);
      continue;
    }
    if (pos.direction === 'short' && high >= pos.stopLoss) {
      exit(symbol, 'stop_loss', pos.stopLoss);
      continue;
    }

    // ── Take profit hit? ──────────────────────────────────────────────────
    if (pos.direction === 'long' && high >= pos.takeProfit) {
      exit(symbol, 'take_profit', pos.takeProfit);
      continue;
    }
    if (pos.direction === 'short' && low <= pos.takeProfit) {
      exit(symbol, 'take_profit', pos.takeProfit);
      continue;
    }

    // ── Trailing stop hit? ────────────────────────────────────────────────
    if (pos.trailingStop !== pos.stopLoss) {
      if (pos.direction === 'long' && low <= pos.trailingStop) {
        exit(symbol, 'trailing_stop', pos.trailingStop);
        continue;
      }
      if (pos.direction === 'short' && high >= pos.trailingStop) {
        exit(symbol, 'trailing_stop', pos.trailingStop);
        continue;
      }
    }

    // ── Time-based exit: close stale positions with no profit ─────────────
    if (pos.candleCount >= 60) {
      const priceDiff = pos.direction === 'long'
        ? close - pos.entryPrice
        : pos.entryPrice - close;
      if (priceDiff <= 0) {
        exit(symbol, 'time_exit');
        continue;
      }
    }

    // ── Signal reversal exit (only after minimum hold) ────────────────────
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
