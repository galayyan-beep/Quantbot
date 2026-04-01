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

const {
  INITIAL_CAPITAL,
  MAX_CANDLE_HIST,
  WARMUP_CANDLES,
  TICK_INTERVAL_MS,
  DEFAULT_PARAMS,
  isInPeakHours,
} = require('./config');

const sessionStartIdx = {};
let lastDashboardSnapshotAt = 0;

// ─── Confirmation candle tracking ────────────────────────────────────────────
// Stores pending signals that need a second candle of confirmation before entry.
// { symbol: { direction, score, reasons, activeSignals, tick, sentimentScore } }
const pendingSignals = {};

function isWeekendUtc(timestamp = Date.now()) {
  const day = new Date(timestamp).getUTCDay();
  return day === 0 || day === 6;
}

function isWeekendEligibleSymbol(symbol) {
  return prices.getInstrumentInfo(symbol)?.category === 'crypto';
}

function setupFingerprint(symbol, direction, reasons = []) {
  const normalizedReasons = [...new Set((reasons || []).map(reason => String(reason).split(':')[0]).filter(Boolean))].sort();
  return [symbol, direction || 'none', normalizedReasons.join('+') || 'no-signal'].join('|');
}

function higherTimeframeTrend(symbol, candleHistory) {
  const candles = candleHistory[symbol] || [];
  if (candles.length < 60) return { bias: 'neutral', aligned: true, reason: 'insufficient_higher_timeframe_history' };
  const closes = candles.map(candle => Number(candle.close || 0)).filter(Number.isFinite);
  const fastPeriod = closes.length >= 144 ? 55 : 21;
  const slowPeriod = closes.length >= 144 ? 144 : 55;
  const ema55 = indicators.ema(closes, fastPeriod);
  const ema144 = indicators.ema(closes, slowPeriod);
  const lastClose = closes[closes.length - 1] || 0;
  if (!ema55 || !ema144 || !lastClose) return { bias: 'neutral', aligned: true, reason: 'higher_timeframe_indicators_unavailable' };

  const separation = Math.abs(ema55 - ema144) / lastClose;
  if (separation < 0.0015) return { bias: 'neutral', aligned: true, reason: 'higher_timeframe_flat' };
  return ema55 > ema144
    ? { bias: 'long', aligned: true, reason: `higher_timeframe_bullish_${fastPeriod}_${slowPeriod}` }
    : { bias: 'short', aligned: true, reason: `higher_timeframe_bearish_${fastPeriod}_${slowPeriod}` };
}

function effectiveEntryRequirements(symbol, entryReq, higherTf, signal) {
  const category = prices.getInstrumentInfo(symbol)?.category || 'other';
  let minScore = entryReq.minScore;
  let minActiveSignals = entryReq.minActiveSignals;
  if (entryReq.weekendMode && category === 'crypto' && signal?.direction && higherTf?.bias === signal.direction) {
    minScore = Math.max(2, minScore - 1);
    minActiveSignals = Math.max(1, minActiveSignals - 1);
  }
  return {
    ...entryReq,
    minScore,
    minActiveSignals,
  };
}

async function hydrateStartupHistory(candleHistory) {
  const broker = prices.getBroker();
  if (!broker || typeof broker.fetchHistoricalCandles !== 'function') return;
  const weekendMode = isWeekendUtc();
  const targetSymbols = weekendMode
    ? prices.getSymbols().filter(isWeekendEligibleSymbol)
    : prices.getSymbols();
  const targetBars = weekendMode ? 180 : 90;

  for (const symbol of targetSymbols) {
    const existing = candleHistory[symbol] || [];
    if (existing.length >= targetBars) continue;
    try {
      const history = await broker.fetchHistoricalCandles(symbol, { resolution: 'MINUTE', max: targetBars });
      if (history.length) {
        candleHistory[symbol] = history.slice(-MAX_CANDLE_HIST);
        sessionStartIdx[symbol] = Math.max(0, candleHistory[symbol].length - 144);
      }
    } catch (err) {
      logger.warn('MAIN', 'Startup history hydration failed', { symbol, error: err.message });
    }
  }
}

function classifyRegime(ind, params) {
  if (!ind || !ind.close) return 'normal';
  const close = Number(ind.close || 0);
  if (!close) return 'normal';
  const ema8 = Number(ind.ema8 || 0);
  const ema21 = Number(ind.ema21 || 0);
  const bandwidth = Number(ind.bb?.bandwidth || 0);
  const momentum = Number(ind.momentum3 || 0);
  const trendStrength = Math.abs(ema8 - ema21) / close;
  const momThreshold = Number(params?.momentumThreshold || 0.003);

  const trending = trendStrength > 0.0025 && Math.abs(momentum) > (momThreshold * 0.8) && bandwidth > 0.008;
  const choppy = trendStrength < 0.0012 && bandwidth < 0.006;
  if (trending) return 'trending';
  if (choppy) return 'choppy';
  return 'normal';
}

function adaptiveEntryRequirements(symbol, ind, params) {
  const baseMinScore = Number(params?.minScore || 3);
  const regime = classifyRegime(ind, params);
  const category = prices.getInstrumentInfo(symbol)?.category || 'other';
  const weekendMode = isWeekendUtc();
  let minScore = baseMinScore;
  let minActiveSignals = 2;

  if (regime === 'trending') {
    minScore = Math.max(2, baseMinScore - 1);
    minActiveSignals = 1;
  } else if (regime === 'choppy') {
    minScore = Math.min(4, baseMinScore + 1);
    minActiveSignals = 2;
  }

  if (weekendMode && category === 'crypto') {
    if (regime === 'choppy') {
      minScore = Math.max(3, baseMinScore);
      minActiveSignals = 2;
    }
  }

  return {
    symbol,
    regime,
    weekendMode,
    minScore,
    minActiveSignals,
  };
}

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
    // Respect saved paper trading state — only override via LIVE_TRADING env var.
    if (saved.PAPER_TRADING === undefined) saved.PAPER_TRADING = true;
    if (!saved.paperTradingStartTime) saved.paperTradingStartTime = Date.now();
    if (!saved.lastDailyReportAt) saved.lastDailyReportAt = 0;
    if (saved.capital === undefined) saved.capital = INITIAL_CAPITAL;
    if (saved.peakCapital === undefined) saved.peakCapital = saved.capital;
    saved.params = { ...DEFAULT_PARAMS, ...(saved.params || {}) };
    // Safety bounds: prevent optimizer from going too aggressive
    if ((saved.params.atrMultiplier || 0) < 2.5) saved.params.atrMultiplier = 2.5;
    if ((saved.params.riskPercent || 0) > 2) saved.params.riskPercent = 2;
    if ((saved.params.minScore || 0) < 3) saved.params.minScore = 3;
    saved.LIVE_TRADING = process.env.LIVE_TRADING === 'true';
    if (!saved.instruments) {
      saved.instruments = Object.fromEntries(prices.getSymbols().map(s => [s, { enabled: true, sizeMultiplier: 1.0 }]));
    }
    if (!saved.setupCooldowns) saved.setupCooldowns = {};
    if (!saved.setupStopoutCounts) saved.setupStopoutCounts = {};
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
    PAPER_TRADING: true,
    paperTradingStartTime: Date.now(),
    lastPaperHourSummaryAt: 0,
    lastPaperVerdictAt: 0,
    lastDailyReportAt: 0,
    LIVE_TRADING: process.env.LIVE_TRADING === 'true',
    backtestSummary: {},
    sentimentSummary: {},
    correlationSummary: {},
    setupCooldowns: {},
    setupStopoutCounts: {},
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
    setupCooldowns: state.setupCooldowns,
    setupStopoutCounts: state.setupStopoutCounts,
  });

  logger.writeJSON('signals.json', signalsMod.getState());
  logger.writeJSON('instruments.json', state.instruments);

  const slim = {};
  for (const [sym, arr] of Object.entries(candleHistory)) slim[sym] = arr.slice(-WARMUP_CANDLES);
  logger.writeJSON('candles.json', slim);
}

function summarizeWatchDecision({ symbol, instrument, marketStatus, indicator, signal, entryReq, pre, corrGate, mem, sizing, state, higherTf, setupBlockedReason }) {
  if (state?.openPositions?.[symbol]) return { label: 'OPEN', tone: 'good', reason: 'Position already open' };
  if (instrument?.enabled === false) return { label: 'DISABLED', tone: 'bad', reason: 'Instrument disabled by optimizer' };
  if (entryReq?.weekendMode && !isWeekendEligibleSymbol(symbol)) return { label: 'WEEKEND', tone: 'warn', reason: 'Weekend mode trades crypto only' };
  if (!marketStatus?.isOpen) return { label: 'MARKET CLOSED', tone: 'warn', reason: marketStatus?.status || 'Unknown market status' };
  if (!indicator || !indicator.atr7) return { label: 'WARMING', tone: 'warn', reason: 'Insufficient indicator data' };
  if (signal?.blockedBySentiment) return { label: 'BLOCKED', tone: 'bad', reason: 'Sentiment blocks current direction' };
  if (!signal?.direction) return { label: 'WAITING', tone: 'neutral', reason: 'No direction selected' };
  if (setupBlockedReason) return { label: 'SETUP COOLDOWN', tone: 'bad', reason: setupBlockedReason };
  if (higherTf?.bias !== 'neutral' && signal?.direction && higherTf.bias !== signal.direction) return { label: 'HTF MISMATCH', tone: 'warn', reason: higherTf.reason };
  if (signal.score < entryReq.minScore || signal.activeSignals < entryReq.minActiveSignals) {
    return { label: 'THRESHOLD', tone: 'warn', reason: `Score ${signal.score}/${entryReq.minScore}, signals ${signal.activeSignals}/${entryReq.minActiveSignals}` };
  }
  if (!pre.allowed) return { label: 'GUARD', tone: 'bad', reason: pre.reason };
  if (!corrGate.allowed) return { label: 'CORRELATION', tone: 'bad', reason: corrGate.reason };
  if (mem.skip) return { label: 'MEMORY', tone: 'bad', reason: mem.reason };
  if (!sizing) return { label: 'SIZE BLOCK', tone: 'bad', reason: 'Risk sizing rejected trade' };
  return { label: 'READY', tone: 'good', reason: 'Meets current entry requirements' };
}

async function writeDashboardSnapshot(state, candleHistory, indicatorsMap) {
  const now = Date.now();
  if (now - lastDashboardSnapshotAt < 10000) return;
  lastDashboardSnapshotAt = now;

  const broker = prices.getBroker();
  let capitalAccount = {
    connected: false,
    paperTrading: !state.LIVE_TRADING,
    activeAccountId: null,
    targetAccountId: process.env.CAPITAL_ACCOUNT_ID || '313428098873906372',
    activeAccount: null,
    targetAccount: null,
    accounts: [],
    positions: [],
  };

  if (broker && typeof broker.getAccountSnapshot === 'function' && typeof broker.getOpenPositions === 'function') {
    try {
      const [accountSnapshot, positionSnapshot] = await Promise.all([
        broker.getAccountSnapshot(),
        broker.getOpenPositions(),
      ]);
      capitalAccount = {
        ...capitalAccount,
        ...accountSnapshot,
        positions: positionSnapshot?.positions || [],
      };
    } catch (err) {
      capitalAccount = {
        ...capitalAccount,
        error: err.message,
      };
    }
  }

  const drawdown = risk.calcDrawdown(state.capital, state.peakCapital);
  const watchlist = prices.getSymbols().map(symbol => {
    const instrument = state.instruments[symbol] || { enabled: true, sizeMultiplier: 1 };
    const candles = candleHistory[symbol] || [];
    const latest = candles[candles.length - 1] || null;
    const indicator = indicatorsMap[symbol] || null;
    const entryReq = adaptiveEntryRequirements(symbol, indicator, state.params);
    const signal = indicator ? signalsMod.score(indicator, state.params, symbol) : {
      direction: null,
      score: 0,
      reasons: [],
      activeSignals: 0,
      sentimentScore: 0,
      blockedBySentiment: false,
    };
    const marketStatus = prices.getCachedMarketStatus(symbol) || { isOpen: false, status: 'UNKNOWN' };
    const higherTf = higherTimeframeTrend(symbol, candleHistory);
    const effectiveReq = effectiveEntryRequirements(symbol, entryReq, higherTf, signal);
    const fp = memoryMod.fingerprint(indicator, symbol);
    const mem = memoryMod.checkCondition(fp);
    const setupKey = setupFingerprint(symbol, signal.direction, signal.reasons);
    const setupCooldownUntil = Number(state.setupCooldowns?.[setupKey] || 0);
    const setupBlockedReason = setupCooldownUntil > now ? `Setup cooled down until ${new Date(setupCooldownUntil).toLocaleTimeString()}` : null;
    const pre = risk.preTradChecks({
      symbol,
      direction: signal.direction,
      openPositions: state.openPositions,
      drawdown,
      params: state.params,
      cooldowns: state.cooldowns,
      recentLossBySymbol: state.recentLossBySymbol,
      winRateBuffer: state.winRateBuffer,
      mode: state.mode,
    });
    const corrGate = correlation.canOpen(symbol, state.openPositions);
    const side = signal.direction === 'long' ? 'buy' : 'sell';
    const entryPrice = signal.direction ? prices.executionPrice(symbol, side) : null;
    const sizing = signal.direction && indicator?.atr7
      ? risk.calcPositionSize(symbol, signal.direction, entryPrice, indicator.atr7, state.params, state.capital, state.openPositions)
      : null;
    const decision = summarizeWatchDecision({
      symbol,
      instrument,
      marketStatus,
      indicator,
      signal,
      entryReq: effectiveReq,
      pre,
      corrGate,
      mem,
      sizing,
      state,
      higherTf,
      setupBlockedReason,
    });

    return {
      symbol,
      category: prices.getInstrumentInfo(symbol)?.category || null,
      latestPrice: latest?.close ?? null,
      lastCandleAt: latest?.timestamp || null,
      marketStatus: marketStatus?.status || null,
      marketOpen: !!marketStatus?.isOpen,
      regime: effectiveReq.regime,
      higherTimeframeBias: higherTf.bias,
      higherTimeframeReason: higherTf.reason,
      minScore: effectiveReq.minScore,
      minActiveSignals: effectiveReq.minActiveSignals,
      signalDirection: signal.direction,
      signalScore: signal.score,
      activeSignals: signal.activeSignals,
      reasons: signal.reasons || [],
      sentimentScore: signal.sentimentScore,
      blockedBySentiment: !!signal.blockedBySentiment,
      memoryWinRate: mem.winRate,
      memorySamples: mem.samples || 0,
      memoryReason: mem.reason,
      pretradeAllowed: pre.allowed,
      pretradeReason: pre.reason,
      correlationAllowed: corrGate.allowed,
      correlationReason: corrGate.reason,
      setupKey,
      setupCooldownUntil: setupCooldownUntil || null,
      cooldownUntil: Number(state.cooldowns?.[symbol] || 0) || null,
      instrumentEnabled: instrument.enabled !== false,
      sizeMultiplier: instrument.sizeMultiplier || 1,
      hasOpenPosition: !!state.openPositions[symbol],
      proposedSize: sizing?.size ?? null,
      proposedRiskAmount: sizing?.riskAmount ?? null,
      decision,
    };
  });

  logger.writeJSON('dashboard_snapshot.json', {
    generatedAt: nowISO(),
    capitalAccount,
    botView: {
      mode: state.mode,
      liveTrading: state.LIVE_TRADING,
      paperTrading: state.PAPER_TRADING,
      drawdown,
      watchlist,
    },
  });
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

  // Cleanup winRateBuffer to prevent memory leak
  if (state.winRateBuffer.length > 500) {
    state.winRateBuffer = state.winRateBuffer.slice(-250);
  }

  // ── Stale-state recovery: if no positions are open and all symbols are blocked,
  //    reset loss counters and expired cooldowns so the bot can trade again.
  if (Object.keys(state.openPositions).length === 0) {
    // Clean up expired cooldowns
    for (const key of Object.keys(state.cooldowns)) {
      if (state.cooldowns[key] < Date.now()) {
        delete state.cooldowns[key];
      }
    }
    // Clean up expired loss cooldowns and reset counters
    for (const sym of prices.getSymbols()) {
      const lossCooldown = state.cooldowns[sym + '_loss_cooldown'];
      if (lossCooldown && Date.now() >= lossCooldown) {
        delete state.cooldowns[sym + '_loss_cooldown'];
        state.recentLossBySymbol[sym] = 0;
      }
    }
  }

  // Cleanup pfWindowTrades to prevent memory leak
  if (state.pfWindowTrades.length > 200) {
    state.pfWindowTrades = state.pfWindowTrades.slice(-100);
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
    const candle = newCandles[sym];
    if (!candle) continue;
    pos.lastPrice = candle.close;  // Track for drawdown force-close decisions
    const ind = indicatorsMap[sym];
    if (!ind || !ind.atr7) continue;
    const ts = risk.updateTrailingStop(pos, candle.close, ind.atr7);
    if (ts !== null) pos.trailingStop = ts;
  }

  const symbolsReadyForTrading = prices.getSymbols().filter(sym => {
    const ins = state.instruments[sym] || { enabled: true };
    if (isWeekendUtc() && !isWeekendEligibleSymbol(sym)) return false;
    return ins.enabled !== false && (candleHistory[sym]?.length || 0) >= WARMUP_CANDLES;
  });
  const warmEnough = symbolsReadyForTrading.length > 0;
  if (warmEnough) {
    for (const sym of prices.getSymbols()) {
      if (isWeekendUtc() && !isWeekendEligibleSymbol(sym)) {
        logEntryBlocked(sym, 'weekend_mode_symbol_disabled');
        continue;
      }

      const ins = state.instruments[sym] || { enabled: true, sizeMultiplier: 1 };
      if (!ins.enabled) {
        logEntryBlocked(sym, 'instrument_disabled');
        continue;
      }

      // Only trade during peak liquidity hours for each instrument
      if (!isInPeakHours(sym)) {
        logEntryBlocked(sym, 'outside_peak_hours');
        continue;
      }

      let marketStatus = prices.getCachedMarketStatus(sym);
      if (!marketStatus) {
        try {
          marketStatus = await prices.getMarketStatus(sym);
        } catch (err) {
          logEntryBlocked(sym, 'market_status_check_failed', { error: err.message });
          continue;
        }
      }
      if (!marketStatus || !marketStatus.isOpen) {
        logEntryBlocked(sym, 'market_closed', { marketStatus: marketStatus?.status || null });
        continue;
      }

      const ind = indicatorsMap[sym];
      if (!ind || !ind.atr7) {
        logEntryBlocked(sym, 'insufficient_indicator_data');
        continue;
      }

      const entryReq = adaptiveEntryRequirements(sym, ind, state.params);
  const higherTf = higherTimeframeTrend(sym, candleHistory);

      const sig = signalsMod.score(ind, state.params, sym);
      const effectiveReq = effectiveEntryRequirements(sym, entryReq, higherTf, sig);
      if (sig.blockedBySentiment) {
        delete pendingSignals[sym];
        logEntryBlocked(sym, 'sentiment_contradiction', {
          sentimentScore: sig.sentimentScore,
          direction: sig.direction,
          regime: effectiveReq.regime,
        });
        continue;
      }
      if (!sig.direction || sig.score < effectiveReq.minScore || sig.activeSignals < effectiveReq.minActiveSignals) {
        delete pendingSignals[sym];
        logEntryBlocked(sym, 'signal_threshold_not_met', {
          direction: sig.direction || null,
          score: sig.score,
          minScore: effectiveReq.minScore,
          minActiveSignals: effectiveReq.minActiveSignals,
          activeSignals: sig.activeSignals,
          regime: effectiveReq.regime,
        });
        continue;
      }

      // ── Confirmation candle: require signal to persist for 2 consecutive ticks ──
      const pending = pendingSignals[sym];
      if (!pending || pending.direction !== sig.direction) {
        // First tick with this signal — store it and wait for confirmation
        pendingSignals[sym] = {
          direction: sig.direction,
          score: sig.score,
          reasons: sig.reasons,
          activeSignals: sig.activeSignals,
          sentimentScore: sig.sentimentScore,
          confirmedAt: Date.now(),
        };
        logEntryBlocked(sym, 'awaiting_confirmation_candle', {
          direction: sig.direction,
          score: sig.score,
          regime: effectiveReq.regime,
        });
        continue;
      }
      // Signal confirmed on second tick — clear pending and proceed to entry
      delete pendingSignals[sym];
      if (higherTf.bias !== 'neutral' && sig.direction && higherTf.bias !== sig.direction) {
        logEntryBlocked(sym, 'higher_timeframe_mismatch', {
          direction: sig.direction,
          higherTimeframeBias: higherTf.bias,
          reason: higherTf.reason,
          regime: effectiveReq.regime,
        });
        continue;
      }

      const setupKey = setupFingerprint(sym, sig.direction, sig.reasons);
      const setupCooldownUntil = Number(state.setupCooldowns?.[setupKey] || 0);
      if (setupCooldownUntil > Date.now()) {
        logEntryBlocked(sym, 'setup_cooldown_active', {
          setupKey,
          until: setupCooldownUntil,
          regime: effectiveReq.regime,
        });
        continue;
      }

      const existingPos = state.openPositions[sym];
      if (existingPos && existingPos.direction === sig.direction) {
        logEntryBlocked(sym, 'open_position_same_direction', {
          direction: sig.direction,
          existingEntryPrice: existingPos.entryPrice,
          regime: effectiveReq.regime,
        });
        continue;
      }

      if (existingPos && existingPos.direction !== sig.direction) {
        logger.warn('MAIN', 'Closing opposite position before reverse entry', {
          symbol: sym,
          existingDirection: existingPos.direction,
          nextDirection: sig.direction,
          regime: effectiveReq.regime,
        });
        const reversed = executor.exit(sym, 'signal_reverse');
        if (!reversed) {
          logEntryBlocked(sym, 'reverse_close_failed', {
            existingDirection: existingPos.direction,
            attemptedDirection: sig.direction,
            regime: effectiveReq.regime,
          });
          continue;
        }
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
        logEntryBlocked(sym, 'pretrade_guard', { guardReason: pre.reason, regime: effectiveReq.regime });
        continue;
      }

      const corrGate = correlation.canOpen(sym, state.openPositions);
      if (!corrGate.allowed) {
        logEntryBlocked(sym, 'correlation_gate', { guardReason: corrGate.reason, coefficient: corrGate.coefficient, regime: effectiveReq.regime });
        continue;
      }

      const fp = memoryMod.fingerprint(ind, sym);
      const mem = memoryMod.checkCondition(fp);
      if (mem.skip) {
        logEntryBlocked(sym, 'memory_gate', { guardReason: mem.reason, regime: effectiveReq.regime });
        continue;
      }

      const side = sig.direction === 'long' ? 'buy' : 'sell';
      const entryPrice = prices.executionPrice(sym, side);
      const sizing = risk.calcPositionSize(sym, sig.direction, entryPrice, ind.atr7, state.params, state.capital, state.openPositions);
      if (!sizing) {
        logEntryBlocked(sym, 'position_sizing_rejected', { regime: effectiveReq.regime });
        continue;
      }

      const currentExposure = risk.totalOpenExposure(state.openPositions);
      const maxExposure = risk.MAX_TOTAL_EXPOSURE_WITH_TOLERANCE;
      const remainingExposure = Number((maxExposure - currentExposure).toFixed(8));
      if (remainingExposure <= 0) {
        logEntryBlocked(sym, 'exposure_cap_reached', { currentExposure, maxExposure, regime: effectiveReq.regime });
        continue;
      }

      const corrAdjustedRisk = correlation.portfolioCorrelationRisk(state.openPositions) + sizing.riskAmount;
      if (corrAdjustedRisk > state.capital * 0.15) {
        logEntryBlocked(sym, 'correlation_adjusted_risk_cap', {
          risk: Number(corrAdjustedRisk.toFixed(2)),
          cap: Number((state.capital * 0.15).toFixed(2)),
          regime: effectiveReq.regime,
        });
        continue;
      }

      const volMul = correlation.positionVolMultiplier(sym);
      const sizeMultiplier = (ins.sizeMultiplier || 1) * memoryMod.sizeMultiplier(fp) * volMul;
      let size = Number((sizing.size * sizeMultiplier).toFixed(8));
      if (size <= 0) {
        logEntryBlocked(sym, 'size_after_multipliers_invalid', { regime: effectiveReq.regime });
        continue;
      }

      const maxSizeByExposure = Number((remainingExposure / entryPrice).toFixed(8));
      if (size > maxSizeByExposure) {
        size = maxSizeByExposure;
      }
      if (size <= 0) {
        logEntryBlocked(sym, 'size_after_exposure_clamp_invalid', { currentExposure, maxExposure, regime: effectiveReq.regime });
        continue;
      }

      const proposedExposure = Number((size * entryPrice).toFixed(8));
      if (currentExposure + proposedExposure > maxExposure + 1e-8) {
        logEntryBlocked(sym, 'exposure_cap_exceeded', { currentExposure, proposedExposure, maxExposure, regime: effectiveReq.regime });
        continue;
      }

      const adjustedRiskAmount = Number((size * sizing.stopDistance).toFixed(8));

      await executor.enter(sym, sig.direction, size, sizing.stopLoss, sizing.takeProfit, adjustedRiskAmount, sig.reasons, sig.sentimentScore);
      
      // Verify position was created
      if (!state.openPositions[sym]) {
        logger.error('MAIN', 'EXECUTOR FAILED TO CREATE POSITION', { symbol: sym, direction: sig.direction });
        continue;
      }

      state.openPositions[sym].atrMultiplier = state.params.atrMultiplier;
      state.openPositions[sym].entryRegime = effectiveReq.regime;
      state.openPositions[sym].setupKey = setupKey;
      state.openPositions[sym].higherTimeframeBias = higherTf.bias;
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

  await writeDashboardSnapshot(state, candleHistory, indicatorsMap);
}

async function main() {
  logger.info('MAIN', 'Quantbot upgrade runtime booting');
  await pingInternet();
  await probeCapitalHosts();

  const state = loadState();
  state.LIVE_TRADING = process.env.LIVE_TRADING === 'true';
  // Only disable paper trading if LIVE_TRADING is explicitly enabled
  if (state.LIVE_TRADING) state.PAPER_TRADING = false;
  // Safety bounds for live trading
  if ((state.params.riskPercent || 0) > 2) state.params.riskPercent = 2;
  if ((state.params.atrMultiplier || 0) < 2.5) state.params.atrMultiplier = 2.5;
  if ((state.params.minScore || 0) < 3) state.params.minScore = 3;

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
  await hydrateStartupHistory(candleHistory);

  executor.init(state, savedTrades);
  state._executor = executor;  // Allow optimizer L5 to close positions on drawdown

  // SAFETY CHECK: Detect dual opposite positions at startup
  const openTrades = executor.getTradeLog().filter(t => !t.exitTime);
  const positionsBySymbol = {};
  for (const trade of openTrades) {
    if (!positionsBySymbol[trade.symbol]) {
      positionsBySymbol[trade.symbol] = [];
    }
    positionsBySymbol[trade.symbol].push(trade);
  }
  for (const [sym, posList] of Object.entries(positionsBySymbol)) {
    if (posList.length > 1) {
      const directions = new Set(posList.map(p => p.direction));
      if (directions.size > 1) {
        logger.error('MAIN', 'CRITICAL: Dual opposite positions detected at startup!', {
          symbol: sym,
          positions: posList.map(p => ({ direction: p.direction, entryPrice: p.entryPrice, size: p.size })),
        });
        // Auto-close the losing position
        let worstTrade = null;
        let worstPnL = Infinity;
        for (const trade of posList) {
          const priceDiff = trade.direction === 'long'
            ? (trade.currentPrice || trade.entryPrice) - trade.entryPrice
            : trade.entryPrice - (trade.currentPrice || trade.entryPrice);
          const pnl = priceDiff * trade.size;
          if (pnl < worstPnL) {
            worstPnL = pnl;
            worstTrade = trade;
          }
        }
        if (worstTrade && worstPnL < 0) {
          logger.warn('MAIN', 'Auto-closing worst losing position to prevent hedge bleed', {
            symbol: sym,
            direction: worstTrade.direction,
            pnl: worstPnL,
          });
          executor.exit(sym, 'manual');
        }
      }
    }
  }

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
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  const interval = setInterval(async () => {
    ticks += 1;
    try {
      await tradingLoop(state, candleHistory);
      consecutiveErrors = 0; // reset on success

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
          anthropicTokens: optimizer.getTokensUsed(),
        });
      }
    } catch (err) {
      consecutiveErrors += 1;
      logger.error('MAIN', 'Loop failure', {
        error: err.message,
        tick: ticks,
        consecutiveErrors,
        stack: err.stack?.split('\n').slice(0, 3).join(' | ') || 'no stack',
      });

      // Exit if too many consecutive errors
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.error('MAIN', `CRASH: ${consecutiveErrors} consecutive errors, exiting`, { error: err.message });
        clearInterval(interval);
        writePerformance(state, executor.getTradeLog());
        persistState(state, candleHistory);
        process.exit(1);
      }
    }
  }, TICK_INTERVAL_MS);

  const shutdown = async (sig) => {
    logger.info('MAIN', `Received ${sig}, shutting down`);
    clearInterval(interval);
    writePerformance(state, executor.getTradeLog());
    persistState(state, candleHistory);
    process.exit(0);
  };

  // Catch any unhandled exceptions
  process.on('uncaughtException', (err) => {
    logger.error('MAIN', 'UNCAUGHT_EXCEPTION', { error: err.message, stack: err.stack?.split('\n').slice(0, 5).join(' | ') });
    clearInterval(interval);
    writePerformance(state, executor.getTradeLog());
    persistState(state, candleHistory);
    process.exit(1);
  });

  // Catch any unhandled promise rejections
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('MAIN', 'UNHANDLED_REJECTION', {
      reason: String(reason).slice(0, 500),
      promise: String(promise).slice(0, 200),
    });
    clearInterval(interval);
    writePerformance(state, executor.getTradeLog());
    persistState(state, candleHistory);
    process.exit(1);
  });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error('MAIN: Bootstrap error', err);
  process.exit(1);
});
