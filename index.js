'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const prices = require('./prices');
const indicators = require('./indicators');
const signalsMod = require('./signals');
const risk = require('./risk');
const executor = require('./executor');
const memoryMod = require('./memory');
const optimizer = require('./optimizer');
const sentiment = require('./sentiment');
const correlation = require('./correlation');
const { runBacktest } = require('./backtest');
const { pingInternet, probeCapitalHosts } = require('./capitalApi');

const INITIAL_CAPITAL = 10000;
const MAX_CANDLE_HIST = 220;
const WARMUP_CANDLES = 55;
const TICK_INTERVAL_MS = 2000;
const DEFAULT_PARAMS = {
  riskPercent: 3,
  atrMultiplier: 1.5,
  minScore: 3,
  momentumThreshold: 0.003,
  rsiBuyLevel: 28,
  rsiSellLevel: 72,
  cooldownCandles: 10,
  minHoldCandles: 5,
  maxPositions: 5,
};

const sessionStartIdx = {};

function logEntryBlocked(symbol, reason, extra = {}) {
  logger.info('MAIN', 'Entry blocked', {
    symbol,
    reason,
    ...extra,
  });
}

function nowISO() {
  return new Date().toISOString();
}

function ensureDailyReportDir() {
  const dir = path.join(__dirname, 'data', 'daily_reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadState() {
  const saved = logger.readJSON('state.json', null);
  if (saved) {
    // Live-first runtime: disable mandatory paper gate unless user explicitly re-enables it.
    saved.PAPER_TRADING = false;
    if (!saved.paperTradingStartTime) saved.paperTradingStartTime = Date.now();
    if (!saved.lastDailyReportAt) saved.lastDailyReportAt = 0;
    if (saved.capital === undefined) saved.capital = INITIAL_CAPITAL;
    if (saved.peakCapital === undefined) saved.peakCapital = saved.capital;
    saved.params = { ...DEFAULT_PARAMS, ...(saved.params || {}) };
    if ((saved.params.riskPercent || 0) > 3) saved.params.riskPercent = 3;
    if ((saved.params.minScore || 0) !== 3) saved.params.minScore = 3;
    saved.LIVE_TRADING = process.env.LIVE_TRADING === 'true';
    if (!saved.instruments) {
      saved.instruments = Object.fromEntries(prices.getSymbols().map(s => [s, { enabled: true, sizeMultiplier: 1.0 }]));
    }
    return saved;
  }

  return {
    capital: INITIAL_CAPITAL,
    peakCapital: INITIAL_CAPITAL,
    openPositions: {},
    params: { ...DEFAULT_PARAMS },
    mode: 'normal',
    observationUntil: null,
    cooldowns: {},
    recentLossBySymbol: {},
    winRateBuffer: [],
    tradeCount: 0,
    lastMemoryReviewAt: 0,
    instruments: Object.fromEntries(prices.getSymbols().map(s => [s, { enabled: true, sizeMultiplier: 1.0 }])),
    profitFactorWindow: null,
    pfWindowTrades: [],
    PAPER_TRADING: false,
    paperTradingStartTime: Date.now(),
    lastPaperHourSummaryAt: 0,
    lastPaperVerdictAt: 0,
    lastDailyReportAt: 0,
    LIVE_TRADING: process.env.LIVE_TRADING === 'true',
    backtestSummary: {},
    sentimentSummary: {},
    correlationSummary: {},
  };
}

function persistState(state, candleHistory) {
  logger.writeJSON('state.json', {
    capital: state.capital,
    peakCapital: state.peakCapital,
    openPositions: state.openPositions,
    params: state.params,
    mode: state.mode,
    observationUntil: state.observationUntil,
    cooldowns: state.cooldowns,
    recentLossBySymbol: state.recentLossBySymbol,
    winRateBuffer: state.winRateBuffer,
    tradeCount: state.tradeCount,
    lastMemoryReviewAt: state.lastMemoryReviewAt,
    instruments: state.instruments,
    PAPER_TRADING: state.PAPER_TRADING,
    paperTradingStartTime: state.paperTradingStartTime,
    lastPaperHourSummaryAt: state.lastPaperHourSummaryAt,
    lastPaperVerdictAt: state.lastPaperVerdictAt,
    lastDailyReportAt: state.lastDailyReportAt,
    LIVE_TRADING: state.LIVE_TRADING,
    backtestSummary: state.backtestSummary,
    sentimentSummary: state.sentimentSummary,
    correlationSummary: state.correlationSummary,
  });

  logger.writeJSON('signals.json', signalsMod.getState());
  logger.writeJSON('instruments.json', state.instruments);

  const slim = {};
  for (const [sym, arr] of Object.entries(candleHistory)) slim[sym] = arr.slice(-WARMUP_CANDLES);
  logger.writeJSON('candles.json', slim);
}

function writePerformance(state, trades) {
  const stats = optimizer.recentTradeStats(trades, 20) || {};
  const perf = {
    timestamp: nowISO(),
    capital: Number(state.capital.toFixed(2)),
    peakCapital: Number(state.peakCapital.toFixed(2)),
    drawdown: Number((((state.peakCapital - state.capital) / state.peakCapital) * 100).toFixed(2)),
    openPositions: Object.keys(state.openPositions).length,
    totalTrades: trades.length,
    mode: state.mode,
    ...stats,
  };
  logger.writeJSON('performance.json', perf);
  return perf;
}

function updatePFWindow(state, trade) {
  const cutoff = Date.now() - 30 * 60 * 1000;
  state.pfWindowTrades.push(trade);
  state.pfWindowTrades = state.pfWindowTrades.filter(t => (t.exitTime || 0) >= cutoff);
  const wins = state.pfWindowTrades.filter(t => t.isWin);
  const losses = state.pfWindowTrades.filter(t => !t.isWin);
  if (state.pfWindowTrades.length < 5 || losses.length === 0) {
    state.profitFactorWindow = null;
    return;
  }
  const gw = wins.reduce((a, b) => a + b.pnl, 0);
  const gl = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
  state.profitFactorWindow = gl > 0 ? gw / gl : null;
}

function checkSessionReset(symbol, candleHistory) {
  const candles = candleHistory[symbol];
  if (!candles.length) {
    sessionStartIdx[symbol] = 0;
    return;
  }
  const lastTs = candles[candles.length - 1].timestamp;
  const lastDay = new Date(lastTs).getUTCDate();
  const nowDay = new Date().getUTCDate();
  if (lastDay !== nowDay) sessionStartIdx[symbol] = candles.length;
  if (sessionStartIdx[symbol] === undefined) sessionStartIdx[symbol] = 0;
}

function summarizePaperHour(state, trades) {
  const stats = optimizer.recentTradeStats(trades, Math.min(50, trades.length)) || {};
  const elapsedHours = (Date.now() - state.paperTradingStartTime) / 3600000;
  const hoursRemaining = Math.max(0, 24 - elapsedHours);
  const summary = {
    timestamp: nowISO(),
    virtualPortfolioValue: Number(state.capital.toFixed(2)),
    winRate: stats.winRate || 0,
    profitFactor: stats.profitFactor || 0,
    tradesTaken: trades.length,
    hoursRemaining: Number(hoursRemaining.toFixed(2)),
  };
  const rows = logger.readJSON('paper_trading_results.json', []);
  rows.push(summary);
  logger.writeJSON('paper_trading_results.json', rows);
  logger.info('PAPER', 'Hourly paper summary', summary);
}

function dayVerdictFromMetrics(perf, sentimentState) {
  const pf = perf?.profitFactor || 0;
  const wr = perf?.winRate || 0;
  const dd = (perf?.drawdown || 0) / 100;
  const sentimentMean = sentimentState?.overall?.meanScore || 0;
  if (pf >= 1.3 && wr >= 0.5 && dd < 0.12) return { verdict: 'GOOD DAY', sentiment: sentimentMean };
  if (pf < 0.9 || wr < 0.4 || dd > 0.2) return { verdict: 'BAD DAY', sentiment: sentimentMean };
  return { verdict: 'AVERAGE DAY', sentiment: sentimentMean };
}

async function createDailyReport(state, trades) {
  const perf = writePerformance(state, trades);
  const optimizations = logger.readJSON('optimizations.json', []);
  const changed = optimizations.slice(-20).flatMap(x => x.changes || []);
  const sentimentState = sentiment.getState();
  const vd = dayVerdictFromMetrics(perf, sentimentState);
  const report = {
    timestamp: nowISO(),
    pnl: Number((state.capital - INITIAL_CAPITAL).toFixed(2)),
    winRate: perf.winRate || 0,
    profitFactor: perf.profitFactor || 0,
    aiChanges: changed,
    sentimentSummary: sentimentState,
    verdict: vd.verdict,
  };
  const dir = ensureDailyReportDir();
  const date = new Date().toISOString().slice(0, 10);
  const filePath = path.join(dir, `report_${date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
}

async function finalizePaperCycleIfNeeded(state, trades) {
  if (!state.PAPER_TRADING) return;
  const elapsedMs = Date.now() - state.paperTradingStartTime;
  if (elapsedMs < 24 * 3600 * 1000) return;

  const perf = writePerformance(state, trades);
  const payload = {
    periodHours: 24,
    paperTradingResults: logger.readJSON('paper_trading_results.json', []),
    performance: perf,
    last20: optimizer.recentTradeStats(trades, 20),
    backtestSummary: state.backtestSummary,
    sentimentSummary: state.sentimentSummary,
    correlationSummary: state.correlationSummary,
    optimizations: logger.readJSON('optimizations.json', []).slice(-50),
    insights: logger.readJSON('insights.json', []).slice(-20),
    instruction: 'is this bot ready for live trading? Respond with READY or NOT_READY plus full analysis',
  };

  const result = await optimizer.evaluatePaperReadiness(payload);
  const verdictRaw = String(result?.verdict || 'NOT_READY').toUpperCase();
  const verdict = verdictRaw.includes('READY') && !verdictRaw.includes('NOT_READY') ? 'READY' : verdictRaw;
  const ready = verdict === 'READY' && (perf.profitFactor || 0) > 1.3 && (perf.drawdown || 100) < 15;

  const saved = {
    timestamp: nowISO(),
    verdict,
    ready,
    analysis: result?.analysis || 'No analysis returned',
    guardrails: {
      profitFactor: perf.profitFactor || 0,
      drawdownPercent: perf.drawdown || 0,
      rule: 'READY and profit factor above 1.3 and drawdown below 15 percent',
    },
  };
  logger.writeJSON('paper_trading_verdict.json', saved);
  state.lastPaperVerdictAt = Date.now();

  if (ready) {
    state.PAPER_TRADING = false;
    prices.setMode({ paperTrading: state.PAPER_TRADING || !state.LIVE_TRADING });
    logger.warn('PAPER', 'PAPER TRADING COMPLETE — to enable real money set LIVE_TRADING=true manually');
  } else {
    state.paperTradingStartTime = Date.now();
    logger.warn('PAPER', 'Paper verdict NOT_READY, extending paper trading for another 24h cycle');
  }
}

async function tradingLoop(state, candleHistory) {
  const newCandles = await prices.tick();

  for (const sym of prices.getSymbols()) {
    const candle = newCandles[sym];
    if (!candle) continue;
    checkSessionReset(sym, candleHistory);
    candleHistory[sym].push(candle);
    if (candleHistory[sym].length > MAX_CANDLE_HIST) candleHistory[sym].shift();
  }

  correlation.enforceOpenPositionCorrelation(state, executor);

  const indicatorsMap = {};
  for (const sym of prices.getSymbols()) {
    indicatorsMap[sym] = indicators.calculateAll(candleHistory[sym], sessionStartIdx[sym] || 0);
  }

  const prevTradeCount = executor.getTradeLog().length;
  executor.checkExits(newCandles, indicatorsMap, state.params);

  const allTrades = executor.getTradeLog();
  if (allTrades.length > prevTradeCount) {
    for (let i = prevTradeCount; i < allTrades.length; i++) {
      const t = allTrades[i];
      const fp = memoryMod.fingerprint(indicatorsMap[t.symbol], t.symbol);
      memoryMod.recordTrade(t, fp);
      updatePFWindow(state, t);
      state.tradeCount += 1;
      if (t.isWin && state.params.minScore > DEFAULT_PARAMS.minScore) {
        state.params.minScore = DEFAULT_PARAMS.minScore;
      }
    }
  }

  for (const [sym, pos] of Object.entries(state.openPositions)) {
    const ind = indicatorsMap[sym];
    if (!ind || !ind.atr7) continue;
    const ts = risk.updateTrailingStop(pos, newCandles[sym].close, ind.atr7);
    if (ts !== null) pos.trailingStop = ts;
  }

  const symbolsReadyForTrading = prices.getSymbols().filter(sym => {
    const ins = state.instruments[sym] || { enabled: true };
    return ins.enabled !== false && (candleHistory[sym]?.length || 0) >= WARMUP_CANDLES;
  });
  const warmEnough = symbolsReadyForTrading.length > 0;
  if (warmEnough) {
    for (const sym of prices.getSymbols()) {
      if (state.openPositions[sym]) {
        logEntryBlocked(sym, 'open_position_exists');
        continue;
      }
      const ins = state.instruments[sym] || { enabled: true, sizeMultiplier: 1 };
      if (!ins.enabled) {
        logEntryBlocked(sym, 'instrument_disabled');
        continue;
      }

      let marketStatus;
      try {
        marketStatus = await prices.getMarketStatus(sym);
      } catch (err) {
        logEntryBlocked(sym, 'market_status_check_failed', { error: err.message });
        continue;
      }
      if (!marketStatus?.isOpen) {
        logEntryBlocked(sym, 'market_closed', { marketStatus: marketStatus?.status || null });
        continue;
      }

      const ind = indicatorsMap[sym];
      if (!ind || !ind.atr7) {
        logEntryBlocked(sym, 'insufficient_indicator_data');
        continue;
      }

      const sig = signalsMod.score(ind, state.params, sym);
      if (sig.blockedBySentiment) {
        logEntryBlocked(sym, 'sentiment_contradiction', { sentimentScore: sig.sentimentScore, direction: sig.direction });
        continue;
      }
      if (!sig.direction || sig.score < state.params.minScore || sig.activeSignals < 2) {
        logEntryBlocked(sym, 'signal_threshold_not_met', {
          direction: sig.direction || null,
          score: sig.score,
          minScore: state.params.minScore,
          activeSignals: sig.activeSignals,
        });
        continue;
      }

      const dd = risk.calcDrawdown(state.capital, state.peakCapital);
      const pre = risk.preTradChecks({
        symbol: sym,
        direction: sig.direction,
        openPositions: state.openPositions,
        drawdown: dd,
        params: state.params,
        cooldowns: state.cooldowns,
        recentLossBySymbol: state.recentLossBySymbol,
        winRateBuffer: state.winRateBuffer,
        mode: state.mode,
      });
      if (!pre.allowed) {
        logEntryBlocked(sym, 'pretrade_guard', { guardReason: pre.reason });
        continue;
      }

      const corrGate = correlation.canOpen(sym, state.openPositions);
      if (!corrGate.allowed) {
        logEntryBlocked(sym, 'correlation_gate', { guardReason: corrGate.reason, coefficient: corrGate.coefficient });
        continue;
      }

      const fp = memoryMod.fingerprint(ind, sym);
      const mem = memoryMod.checkCondition(fp);
      if (mem.skip) {
        logEntryBlocked(sym, 'memory_gate', { guardReason: mem.reason });
        continue;
      }

      const side = sig.direction === 'long' ? 'buy' : 'sell';
      const entryPrice = prices.executionPrice(sym, side);
      const sizing = risk.calcPositionSize(sym, sig.direction, entryPrice, ind.atr7, state.params, state.capital, state.openPositions);
      if (!sizing) {
        logEntryBlocked(sym, 'position_sizing_rejected');
        continue;
      }

      const currentExposure = risk.totalOpenExposure(state.openPositions);
      const maxExposure = risk.MAX_TOTAL_EXPOSURE_WITH_TOLERANCE;
      const remainingExposure = Number((maxExposure - currentExposure).toFixed(8));
      if (remainingExposure <= 0) {
        logEntryBlocked(sym, 'exposure_cap_reached', { currentExposure, maxExposure });
        continue;
      }

      const corrAdjustedRisk = correlation.portfolioCorrelationRisk(state.openPositions) + sizing.riskAmount;
      if (corrAdjustedRisk > state.capital * 0.15) {
        logEntryBlocked(sym, 'correlation_adjusted_risk_cap', {
          risk: Number(corrAdjustedRisk.toFixed(2)),
          cap: Number((state.capital * 0.15).toFixed(2)),
        });
        continue;
      }

      const volMul = correlation.positionVolMultiplier(sym);
      const sizeMultiplier = (ins.sizeMultiplier || 1) * memoryMod.sizeMultiplier(fp) * volMul;
      let size = Number((sizing.size * sizeMultiplier).toFixed(8));
      if (size <= 0) {
        logEntryBlocked(sym, 'size_after_multipliers_invalid');
        continue;
      }

      const maxSizeByExposure = Number((remainingExposure / entryPrice).toFixed(8));
      if (size > maxSizeByExposure) {
        size = maxSizeByExposure;
      }
      if (size <= 0) {
        logEntryBlocked(sym, 'size_after_exposure_clamp_invalid', { currentExposure, maxExposure });
        continue;
      }

      const proposedExposure = Number((size * entryPrice).toFixed(8));
      if (currentExposure + proposedExposure > maxExposure + 1e-8) {
        logEntryBlocked(sym, 'exposure_cap_exceeded', { currentExposure, proposedExposure, maxExposure });
        continue;
      }

      const adjustedRiskAmount = Number((size * sizing.stopDistance).toFixed(8));

      executor.enter(sym, sig.direction, size, sizing.stopLoss, sizing.takeProfit, adjustedRiskAmount, sig.reasons, sig.sentimentScore);
      state.openPositions[sym].atrMultiplier = state.params.atrMultiplier;
    }
  }

  const drawdown = risk.calcDrawdown(state.capital, state.peakCapital);
  await optimizer.layer5SelfHeal(allTrades, drawdown, state.profitFactorWindow);

  state.sentimentSummary = {
    updatedAt: sentiment.getState().updatedAt || 0,
    meanScore: sentiment.getState().overall?.meanScore || 0,
  };
  state.correlationSummary = {
    updatedAt: correlation.getState().updatedAt || 0,
    openRisk: correlation.portfolioCorrelationRisk(state.openPositions),
  };

  if (state.PAPER_TRADING) {
    if (!state.lastPaperHourSummaryAt || Date.now() - state.lastPaperHourSummaryAt >= 60 * 60 * 1000) {
      summarizePaperHour(state, allTrades);
      state.lastPaperHourSummaryAt = Date.now();
    }
    await finalizePaperCycleIfNeeded(state, allTrades);
  }

  if (state.tradeCount > 0 && state.tradeCount % 100 === 0 && state.tradeCount !== state.lastMemoryReviewAt) {
    state.lastMemoryReviewAt = state.tradeCount;
    await optimizer.layer4Memory();
  }

  if (!state.lastDailyReportAt || Date.now() - state.lastDailyReportAt >= 24 * 3600 * 1000) {
    await createDailyReport(state, allTrades);
    state.lastDailyReportAt = Date.now();
  }
}

async function main() {
  logger.info('MAIN', 'Quantbot upgrade runtime booting');
  await pingInternet();
  await probeCapitalHosts();

  const state = loadState();
  state.LIVE_TRADING = process.env.LIVE_TRADING === 'true';
  state.PAPER_TRADING = false;
  if ((state.params.riskPercent || 0) > 3) state.params.riskPercent = 3;
  state.params.minScore = 3;

  const candleHistory = logger.readJSON('candles.json', Object.fromEntries(prices.getSymbols().map(s => [s, []])));
  const savedTrades = logger.readJSON('trades.json', []);
  const savedMemory = logger.readJSON('memory.json', { entries: [], conditionWeights: {} });
  const savedSignals = logger.readJSON('signals.json', null);

  const savedPrices = {};
  for (const sym of prices.getSymbols()) {
    const h = candleHistory[sym] || [];
    if (h.length) savedPrices[sym] = h[h.length - 1].close;
  }

  const useDemoApi = state.PAPER_TRADING || !state.LIVE_TRADING;
  prices.init(savedPrices, { paperTrading: useDemoApi });
  const broker = prices.getBroker();
  if (broker && typeof broker.auth === 'function') {
    await broker.auth();
  }

  executor.init(state, savedTrades);
  memoryMod.init(savedMemory.entries || [], savedMemory.conditionWeights || {});
  if (savedSignals) signalsMod.loadState(savedSignals);
  optimizer.init(state);

  const backtest = await runBacktest();
  state.backtestSummary = {
    sharpeRatio: backtest?.metrics?.sharpeRatio ?? backtest?.sharpeRatio ?? 0,
    maxDrawdown: backtest?.metrics?.maxDrawdown ?? backtest?.maxDrawdown ?? 1,
  };
  if (state.backtestSummary.sharpeRatio < 0.5 || state.backtestSummary.maxDrawdown > 0.25) {
    logger.warn('MAIN', 'Backtest warning on startup', state.backtestSummary);
  }

  correlation.startHourly(candleHistory);
  sentiment.start();

  if (state.PAPER_TRADING) {
    logger.warn('PAPER', 'PAPER_TRADING=true active. Virtual capital mode with Capital.com demo data.');
  }

  optimizer.startTimers(
    () => executor.getTradeLog(),
    () => state.instruments,
    () => logger.readJSON('optimizations.json', []),
  );

  let ticks = 0;
  const interval = setInterval(async () => {
    ticks += 1;
    try {
      await tradingLoop(state, candleHistory);
      if (ticks % 10 === 0) {
        writePerformance(state, executor.getTradeLog());
        persistState(state, candleHistory);
      }
      if (ticks % 30 === 0) {
        const dd = risk.calcDrawdown(state.capital, state.peakCapital);
        logger.info('MAIN', 'Heartbeat', {
          tick: ticks,
          capital: Number(state.capital.toFixed(2)),
          drawdownPct: Number((dd * 100).toFixed(2)),
          open: Object.keys(state.openPositions).length,
          paperTrading: state.PAPER_TRADING,
          liveTrading: state.LIVE_TRADING,
        });
      }
    } catch (err) {
      logger.error('MAIN', 'Loop failure', { error: err.message });
    }
  }, TICK_INTERVAL_MS);

  const shutdown = async (sig) => {
    logger.info('MAIN', `Received ${sig}, shutting down`);
    clearInterval(interval);
    writePerformance(state, executor.getTradeLog());
    persistState(state, candleHistory);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
