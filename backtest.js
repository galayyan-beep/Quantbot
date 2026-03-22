'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { CapitalClient } = require('./capitalApi');
const indicators = require('./indicators');
const signals = require('./signals');
const risk = require('./risk');
const logger = require('./logger');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'BNB', 'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'GOLD', 'SILVER', 'OIL', 'SPX', 'NQ', 'DAX'];

function daysBetween(a, b) {
  return Math.max(1, Math.round((b - a) / (24 * 3600 * 1000)));
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((x, y) => x - y);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

async function fetchDailyHistory(client, symbol, bars = 730) {
  const epic = require('./capitalApi').EPICS[symbol];
  try {
    await client.auth();
    const { body } = await client.request(`/prices/${encodeURIComponent(epic)}?resolution=DAY&max=${bars}`, { method: 'GET' });
    const arr = body?.prices || [];
    return arr.map(p => ({
      symbol,
      timestamp: Date.parse(p.snapshotTimeUTC || p.snapshotTime || new Date().toISOString()),
      open: Number(p.openPrice?.bid ?? p.openPrice?.ask ?? p.closePrice?.bid ?? 0),
      high: Number(p.highPrice?.bid ?? p.highPrice?.ask ?? 0),
      low: Number(p.lowPrice?.bid ?? p.lowPrice?.ask ?? 0),
      close: Number(p.closePrice?.bid ?? p.closePrice?.ask ?? 0),
      volume: Number(p.lastTradedVolume ?? 1),
    })).filter(c => Number.isFinite(c.close) && c.close > 0);
  } catch (err) {
    logger.warn('BACKTEST', 'Failed to fetch daily history', { symbol, error: err.message });
    return [];
  }
}

function perfMetrics(trades, equityCurve, startedCapital) {
  const finalCapital = equityCurve.length ? equityCurve[equityCurve.length - 1].capital : startedCapital;
  const totalReturn = (finalCapital - startedCapital) / startedCapital;
  const startTs = equityCurve[0]?.ts || Date.now();
  const endTs = equityCurve[equityCurve.length - 1]?.ts || Date.now();
  const years = Math.max(1 / 365, daysBetween(startTs, endTs) / 365);
  const annualized = Math.pow(1 + totalReturn, 1 / years) - 1;

  let peak = startedCapital;
  let maxDd = 0;
  let ddAt = null;
  for (const p of equityCurve) {
    if (p.capital > peak) peak = p.capital;
    const dd = (peak - p.capital) / peak;
    if (dd > maxDd) {
      maxDd = dd;
      ddAt = p.ts;
    }
  }

  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].capital;
    const cur = equityCurve[i].capital;
    returns.push(prev ? (cur - prev) / prev : 0);
  }
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length ? returns.reduce((a, b) => a + ((b - mean) ** 2), 0) / returns.length : 0;
  const stdev = Math.sqrt(variance);
  const rfDaily = 0.04 / 252;
  const sharpe = stdev > 0 ? ((mean - rfDaily) / stdev) * Math.sqrt(252) : 0;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const grossWin = wins.reduce((a, b) => a + b.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? -grossLoss / losses.length : 0;

  return {
    startedCapital,
    finalCapital,
    totalReturn,
    annualizedReturn: annualized,
    maxDrawdown: maxDd,
    maxDrawdownAt: ddAt ? new Date(ddAt).toISOString() : null,
    sharpeRatio: sharpe,
    winRate,
    profitFactor,
    averageWin: avgWin,
    averageLoss: avgLoss,
    bestTrade: trades.length ? trades.reduce((a, b) => a.pnl > b.pnl ? a : b) : null,
    worstTrade: trades.length ? trades.reduce((a, b) => a.pnl < b.pnl ? a : b) : null,
    totalTrades: trades.length,
    averageHoldDays: trades.length ? trades.reduce((a, b) => a + (b.holdDays || 0), 0) / trades.length : 0,
  };
}

function summarizeBreakdowns(trades) {
  const by = (keyFn) => {
    const out = {};
    for (const t of trades) {
      const k = keyFn(t);
      if (!out[k]) out[k] = { pnl: 0, wins: 0, total: 0 };
      out[k].pnl += t.pnl;
      out[k].wins += t.pnl > 0 ? 1 : 0;
      out[k].total += 1;
    }
    return out;
  };

  const byInstrument = by(t => t.symbol);
  const bySignal = by(t => (t.reasons?.[0] || 'unknown').split(':')[0]);
  const byAssetClass = by(t => {
    if (['BTC', 'ETH', 'SOL', 'BNB'].includes(t.symbol)) return 'crypto';
    if (['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD'].includes(t.symbol)) return 'forex';
    if (['GOLD', 'SILVER', 'OIL'].includes(t.symbol)) return 'commodity';
    return 'index';
  });

  const byMonth = by(t => new Date(t.exitTime).toISOString().slice(0, 7));
  const months = Object.entries(byMonth).sort((a, b) => b[1].pnl - a[1].pnl);

  return {
    byInstrument,
    bySignal,
    byAssetClass,
    bestMonth: months[0] ? { month: months[0][0], ...months[0][1] } : null,
    worstMonth: months[months.length - 1] ? { month: months[months.length - 1][0], ...months[months.length - 1][1] } : null,
  };
}

async function askAnthropicWeaknesses(result) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const c = new Anthropic({ apiKey: key });
  const prompt = `You are a quant strategy reviewer. Based on this backtest JSON, return ONLY JSON with the 3 biggest weaknesses and specific fixes. Format: {"weaknesses":[{"issue":"...","fix":"..."},{...},{...}]}`;
  try {
    const res = await c.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      max_tokens: 700,
      messages: [{ role: 'user', content: `${prompt}\n\n${JSON.stringify(result)}` }],
    });
    const text = res.content[0]?.text || '{}';
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch (err) {
    logger.warn('BACKTEST', 'Anthropic backtest analysis failed', { error: err.message });
    return null;
  }
}

async function runBacktest(params = {}) {
  const usePaperTrading = process.env.LIVE_TRADING !== 'true';
  const client = new CapitalClient({ paperTrading: usePaperTrading });
  const history = {};
  for (const s of SYMBOLS) history[s] = await fetchDailyHistory(client, s, 730);

  const lengths = Object.values(history).map(a => Array.isArray(a) ? a.length : 0);
  if (lengths.some(len => len <= 0)) {
    const fallback = { warning: 'Insufficient historical data from Capital.com', sharpeRatio: 0, maxDrawdown: 1 };
    logger.writeJSON('backtest_results.json', fallback);
    return fallback;
  }

  const minLen = Math.min(...lengths);
  if (!Number.isFinite(minLen) || minLen < 120) {
    const fallback = { warning: 'Insufficient historical data from Capital.com', sharpeRatio: 0, maxDrawdown: 1 };
    logger.writeJSON('backtest_results.json', fallback);
    return fallback;
  }

  const state = {
    capital: 10000,
    peak: 10000,
    open: {},
    trades: [],
    equityCurve: [],
  };

  const candles = {};
  for (const s of SYMBOLS) candles[s] = [];

  for (let i = 0; i < minLen; i++) {
    for (const s of SYMBOLS) {
      const row = history[s][i];
      if (!row) continue;
      candles[s].push(row);
    }

    for (const s of SYMBOLS) {
      if (!candles[s].length) continue;
      const ind = indicators.calculateAll(candles[s], 0);
      if (!ind || !ind.atr7 || candles[s].length < 55) continue;

      const cur = candles[s][candles[s].length - 1];
      const pos = state.open[s];
      if (pos) {
        pos.hold += 1;
        if ((pos.direction === 'long' && cur.low <= pos.stopLoss) || (pos.direction === 'short' && cur.high >= pos.stopLoss)) {
          const pnl = (pos.direction === 'long' ? pos.stopLoss - pos.entry : pos.entry - pos.stopLoss) * pos.size;
          state.capital += pnl;
          state.trades.push({ ...pos, exitTime: cur.timestamp, pnl, holdDays: pos.hold });
          delete state.open[s];
          continue;
        }
        if ((pos.direction === 'long' && cur.high >= pos.takeProfit) || (pos.direction === 'short' && cur.low <= pos.takeProfit)) {
          const pnl = (pos.direction === 'long' ? pos.takeProfit - pos.entry : pos.entry - pos.takeProfit) * pos.size;
          state.capital += pnl;
          state.trades.push({ ...pos, exitTime: cur.timestamp, pnl, holdDays: pos.hold });
          delete state.open[s];
          continue;
        }
      }

      if (Object.keys(state.open).length >= 5 || state.open[s]) continue;
      const sig = signals.score(ind, {
        riskPercent: 5,
        atrMultiplier: 1.5,
        minScore: 3,
        momentumThreshold: 0.003,
        rsiBuyLevel: 28,
        rsiSellLevel: 72,
      }, null);
      if (!sig.direction || sig.score < 3 || sig.activeSignals < 2) continue;

      const sizing = risk.calcPositionSize(s, sig.direction, cur.close, ind.atr7, { riskPercent: 5, atrMultiplier: 1.5 }, state.capital, state.open);
      if (!sizing) continue;

      state.open[s] = {
        symbol: s,
        direction: sig.direction,
        entry: cur.close,
        entryTime: cur.timestamp,
        size: sizing.size,
        stopLoss: sizing.stopLoss,
        takeProfit: sizing.takeProfit,
        reasons: sig.reasons,
        hold: 0,
      };
    }

    if (state.capital > state.peak) state.peak = state.capital;
    state.equityCurve.push({ ts: history.SPX[i].timestamp, capital: Number(state.capital.toFixed(2)) });
  }

  const metrics = perfMetrics(state.trades, state.equityCurve, 10000);
  const breakdown = summarizeBreakdowns(state.trades);
  const result = {
    generatedAt: new Date().toISOString(),
    metrics,
    breakdown,
  };

  const ai = await askAnthropicWeaknesses(result);
  if (ai) result.aiWeaknessReview = ai;

  logger.writeJSON('backtest_results.json', result);

  if (metrics.sharpeRatio < 0.5 || metrics.maxDrawdown > 0.25) {
    logger.warn('BACKTEST', 'Backtest risk warning', {
      sharpe: metrics.sharpeRatio,
      maxDrawdown: metrics.maxDrawdown,
    });
  }

  return result;
}

if (require.main === module) {
  runBacktest().then(r => {
    console.log(JSON.stringify(r, null, 2));
  }).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  runBacktest,
};
