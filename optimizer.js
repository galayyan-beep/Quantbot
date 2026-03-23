'use strict';

/**
 * optimizer.js — Five-layer AI self-improvement engine.
 *
 * Layer 1  (every  5 min): Fast parameter adjustment via Anthropic API
 * Layer 2  (every 30 min): Signal weight and instrument enable/disable logic
 * Layer 3  (every  2 hrs): Deep whole-history analysis via Anthropic API
 * Layer 4  (every 100 trades): Memory pattern analysis via Anthropic API
 * Layer 5  (continuous):   Self-healing reactive guards
 *
 * All API calls are non-blocking and wrapped in try-catch so the bot
 * continues trading if Anthropic is unavailable.
 */

const Anthropic = require('@anthropic-ai/sdk');
const logger    = require('./logger');
const signals   = require('./signals');
const memoryMod = require('./memory');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

// ─── Anthropic client (lazy init to allow missing API key) ───────────────────
let _client = null;
function getClient() {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) { logger.warn('OPTIM', 'ANTHROPIC_API_KEY not set — optimization layers disabled'); return null; }
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

// ─── Shared state reference (injected from index.js) ─────────────────────────
let _state = null;

function init(sharedState) {
  _state = sharedState;
}

// ─── Helper: call Claude and parse JSON safely ────────────────────────────────
async function callClaude(systemPrompt, userContent, maxTokens = 1024) {
  const client = getClient();
  if (!client) return null;
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [
        { role: 'user', content: `${systemPrompt}\n\n${userContent}` },
      ],
    });
    const text = res.content[0]?.text || '';
    // Extract first JSON object from response
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { logger.warn('OPTIM', 'No JSON found in Claude response', { text: text.slice(0, 200) }); return null; }
    return JSON.parse(match[0]);
  } catch (err) {
    logger.error('OPTIM', 'Anthropic API error', { error: err.message });
    return null;
  }
}

// ─── Performance helpers ──────────────────────────────────────────────────────
function recentTradeStats(trades, n = 20) {
  const recent = trades.slice(-n);
  if (recent.length === 0) return null;

  const wins       = recent.filter(t => t.isWin);
  const losses     = recent.filter(t => !t.isWin);
  const winRate    = wins.length / recent.length;

  const avgWin     = wins.length  ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss    = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? avgWin * winRate / (avgLoss * (1 - winRate)) : null;

  // Largest drawdown within window
  let peak = 0, maxDD = 0, running = 0;
  for (const t of recent) {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = (peak - running);
    if (dd > maxDD) maxDD = dd;
  }

  // Best / worst instruments
  const bySymbol = {};
  for (const t of recent) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t.pnl);
  }
  const symStats = Object.entries(bySymbol).map(([sym, pnls]) => ({
    symbol: sym,
    pnl:    pnls.reduce((a, b) => a + b, 0),
    trades: pnls.length,
  }));
  symStats.sort((a, b) => b.pnl - a.pnl);

  return {
    count: recent.length,
    winRate: parseFloat(winRate.toFixed(4)),
    profitFactor: profitFactor !== null ? parseFloat(profitFactor.toFixed(4)) : null,
    avgWin:  parseFloat(avgWin.toFixed(4)),
    avgLoss: parseFloat(avgLoss.toFixed(4)),
    maxDrawdown: parseFloat(maxDD.toFixed(4)),
    bestInstruments:  symStats.slice(0, 3).map(s => s.symbol),
    worstInstruments: symStats.slice(-3).map(s => s.symbol),
  };
}

function signalStats(trades) {
  const bySignal = {};
  for (const t of trades) {
    for (const r of (t.reasons || [])) {
      const key = r.split(':')[0];
      if (!bySignal[key]) bySignal[key] = { wins: 0, total: 0, pnl: 0 };
      bySignal[key].total += 1;
      if (t.isWin) bySignal[key].wins += 1;
      bySignal[key].pnl  += t.pnl;
    }
  }
  return bySignal;
}

function recentTradeHealth(trades, n = 30) {
  const recent = (trades || []).filter(t => t && (t.exitTime || t.status === 'closed')).slice(-n);
  if (!recent.length) {
    return {
      count: 0,
      winRate: 0,
      lossRate: 0,
      stopLossRate: 0,
      fastStopRate: 0,
      bySymbol: {},
    };
  }

  const wins = recent.filter(t => t.isWin).length;
  const losses = recent.length - wins;
  const stopLosses = recent.filter(t => t.exitReason === 'stop_loss').length;
  const fastStops = recent.filter(t => Number(t.holdCandles || 0) <= 1).length;

  const bySymbol = {};
  for (const t of recent) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { total: 0, losses: 0, fastStops: 0, pnl: 0 };
    bySymbol[t.symbol].total += 1;
    if (!t.isWin) bySymbol[t.symbol].losses += 1;
    if (Number(t.holdCandles || 0) <= 1) bySymbol[t.symbol].fastStops += 1;
    bySymbol[t.symbol].pnl += Number(t.pnl || 0);
  }

  return {
    count: recent.length,
    winRate: wins / recent.length,
    lossRate: losses / recent.length,
    stopLossRate: stopLosses / recent.length,
    fastStopRate: fastStops / recent.length,
    bySymbol,
  };
}

// ─── LAYER 1: Fast loop — every 5 minutes ────────────────────────────────────
async function layer1Fast(trades) {
  if (!trades || trades.length < 10) return;

  const stats = recentTradeStats(trades, 20);
  if (!stats) return;

  logger.optim('L1', 'Running fast parameter review', stats);

  const PARAM_BOUNDS = {
    riskPercent:        [1,    3],
    atrMultiplier:      [2.5,  3],
    minScore:           [4,    5],
    momentumThreshold:  [0.002, 0.009],
    rsiBuyLevel:        [20,  35],
    rsiSellLevel:       [65,  80],
    cooldownCandles:    [8,   20],
    minHoldCandles:     [5,   12],
  };

  const systemPrompt = `You are a quantitative trading analyst evaluating a paper trading bot's performance.
Analyze the performance data and return ONLY a JSON object with adjusted parameters and a one-sentence reason for each change.
Allowed parameter ranges: ${JSON.stringify(PARAM_BOUNDS)}.
Format: { "riskPercent": { "value": 4.5, "reason": "..." }, "atrMultiplier": { "value": 1.8, "reason": "..." }, ... }
Only include parameters you want to change. Return minimal JSON with no extra text.`;

  const userContent = `Performance data (last 20 trades): ${JSON.stringify(stats)}
Current parameters: ${JSON.stringify(_state.params)}
Backtest summary: ${JSON.stringify(_state.backtestSummary || {})}
Sentiment summary: ${JSON.stringify(_state.sentimentSummary || {})}`;

  const result = await callClaude(systemPrompt, userContent, 1024);
  if (!result) return;

  const changes = [];
  for (const [key, update] of Object.entries(result)) {
    if (!PARAM_BOUNDS[key] || typeof update !== 'object' || update.value === undefined) continue;
    const [lo, hi] = PARAM_BOUNDS[key];
    const clamped  = Math.max(lo, Math.min(hi, Number(update.value)));
    if (isNaN(clamped)) continue;

    const before = _state.params[key];
    _state.params[key] = clamped;
    changes.push({ key, before, after: clamped, reason: update.reason || '' });
  }

  if (changes.length > 0) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      layer: 1,
      stats,
      changes,
    };
    const existing = logger.readJSON('optimizations.json', []);
    existing.push(logEntry);
    logger.writeJSON('optimizations.json', existing);
    logger.optim('L1', `Applied ${changes.length} parameter change(s)`, changes);
  }
}

// ─── LAYER 2: Medium loop — every 30 minutes ─────────────────────────────────
async function layer2Medium(trades, instruments) {
  if (!trades || trades.length < 20) return;

  logger.optim('L2', 'Running medium signal-weight and instrument review', {
    sentiment: _state.sentimentSummary || {},
  });

  const advisory = await callClaude(
    'You are a quant assistant. Return ONLY JSON {"advice":"one sentence"} using sentiment and trade stats context.',
    `Sentiment summary: ${JSON.stringify(_state.sentimentSummary || {})}\nRecent trades: ${JSON.stringify(trades.slice(-30))}`,
    180,
  );
  if (advisory?.advice) {
    logger.optim('L2', 'Sentiment-aware advisory', advisory);
  }

  // Signal performance
  const stats = signalStats(trades.slice(-100));
  for (const [key, s] of Object.entries(stats)) {
    if (s.total < 5) continue;
    const wr = s.wins / s.total;
    if (wr > 0.60) {
      signals.adjustWeight(key, +0.5);
      logger.optim('L2', `Boosted weight for high-performing signal`, { key, winRate: wr.toFixed(2) });
    } else if (wr < 0.40) {
      signals.adjustWeight(key, -0.5);
      logger.optim('L2', `Reduced weight for under-performing signal`, { key, winRate: wr.toFixed(2) });
    }
  }

  // Instrument performance over last 50 trades
  const recent50 = trades.slice(-50);
  const byInstrument = {};
  for (const t of recent50) {
    if (!byInstrument[t.symbol]) byInstrument[t.symbol] = { pnl: 0, wins: 0, total: 0 };
    byInstrument[t.symbol].pnl   += t.pnl;
    byInstrument[t.symbol].wins  += t.isWin ? 1 : 0;
    byInstrument[t.symbol].total += 1;
  }

  for (const [sym, stat] of Object.entries(byInstrument)) {
    if (stat.total < 3) continue;
    const wr = stat.wins / stat.total;

    if (stat.pnl < 0 && wr < 0.35) {
      // Disable consistently losing instrument for 2 hours
      instruments[sym] = instruments[sym] || {};
      instruments[sym].disabledUntil = Date.now() + 2 * 60 * 60 * 1000;
      instruments[sym].enabled       = false;
      logger.optim('L2', `Disabled losing instrument for 2h`, { sym, pnl: stat.pnl.toFixed(2), wr: wr.toFixed(2) });
    } else if (stat.pnl > 0 && wr > 0.65) {
      // Boost consistently winning instrument's size up to 1.5×
      instruments[sym] = instruments[sym] || {};
      const prev = instruments[sym].sizeMultiplier || 1.0;
      instruments[sym].sizeMultiplier = Math.min(1.5, prev * 1.20);
      logger.optim('L2', `Boosted size multiplier for winning instrument`, {
        sym, from: prev.toFixed(2), to: instruments[sym].sizeMultiplier.toFixed(2),
      });
    }
  }

  // Re-enable instruments whose 2h ban has expired
  for (const [sym, cfg] of Object.entries(instruments)) {
    if (!cfg.enabled && cfg.disabledUntil && Date.now() > cfg.disabledUntil) {
      cfg.enabled = true;
      delete cfg.disabledUntil;
      logger.optim('L2', `Re-enabled instrument after cooldown`, { sym });
    }
  }

  logger.writeJSON('signals.json', signals.getState());
  logger.writeJSON('instruments.json', instruments);
}

// ─── LAYER 3: Deep loop — every 2 hours ──────────────────────────────────────
async function layer3Deep(trades, optimizations) {
  if (!trades || trades.length < 30) return;

  logger.optim('L3', 'Running deep AI strategy review');

  // Summarise full history to stay within token limits
  const stats = recentTradeStats(trades, Math.min(trades.length, 200));
  const sigStats = signalStats(trades.slice(-100));
  const recentOpts = (optimizations || []).slice(-10);

  const systemPrompt = `You are a senior quant analyst reviewing a paper trading bot.
Analyze the data and return ONLY a JSON object with exactly these keys:
{
  "biggestPattern": "string — single most important pattern you see",
  "structuralImprovement": "string — one structural improvement suggestion",
  "instrumentReview": "string — comment on instrument selection",
  "parameterSuggestions": { "key": { "value": number, "reason": "string" }, ... },
  "conditionInsight": { "bestCondition": "string", "worstCondition": "string" }
}
Return ONLY the JSON object, no commentary.`;

  const userContent = `Performance summary: ${JSON.stringify(stats)}
Signal statistics: ${JSON.stringify(sigStats)}
Recent optimizations: ${JSON.stringify(recentOpts)}
Current parameters: ${JSON.stringify(_state.params)}
Capital: ${_state.capital.toFixed(2)}, Peak: ${_state.peakCapital.toFixed(2)}
Backtest summary: ${JSON.stringify(_state.backtestSummary || {})}
Sentiment summary: ${JSON.stringify(_state.sentimentSummary || {})}
Correlation risk: ${JSON.stringify(_state.correlationSummary || {})}`;

  const result = await callClaude(systemPrompt, userContent, 2048);
  if (!result) return;

  const insightEntry = {
    timestamp:              new Date().toISOString(),
    biggestPattern:         result.biggestPattern         || '',
    structuralImprovement:  result.structuralImprovement  || '',
    instrumentReview:       result.instrumentReview       || '',
    parameterSuggestions:   result.parameterSuggestions   || {},
  };

  const insights = logger.readJSON('insights.json', []);
  insights.push(insightEntry);
  logger.writeJSON('insights.json', insights);

  logger.optim('L3', 'Deep insight recorded', {
    pattern:   insightEntry.biggestPattern,
    suggestion: insightEntry.structuralImprovement,
  });

  // Apply any parameter suggestions
  const PARAM_BOUNDS = {
    riskPercent: [1, 3], atrMultiplier: [2.5, 3], minScore: [3, 3],
    momentumThreshold: [0.001, 0.008], rsiBuyLevel: [20, 35],
    rsiSellLevel: [65, 80], cooldownCandles: [5, 20], minHoldCandles: [3, 10],
  };

  for (const [key, upd] of Object.entries(result.parameterSuggestions || {})) {
    if (!PARAM_BOUNDS[key] || typeof upd !== 'object' || upd.value === undefined) continue;
    const [lo, hi] = PARAM_BOUNDS[key];
    const clamped  = Math.max(lo, Math.min(hi, Number(upd.value)));
    if (!isNaN(clamped)) {
      logger.optim('L3', `Deep analysis adjusted param`, { key, before: _state.params[key], after: clamped, reason: upd.reason });
      _state.params[key] = clamped;
    }
  }

  return result;
}

// ─── LAYER 4: Memory review — every 100 trades ───────────────────────────────
async function layer4Memory() {
  const mem = memoryMod.getMemory();
  if (!mem || mem.length < 50) return;

  logger.optim('L4', 'Running memory pattern analysis');

  // Aggregate by fingerprint
  const byFP = {};
  for (const entry of mem) {
    if (!byFP[entry.fingerprint]) byFP[entry.fingerprint] = { wins: 0, total: 0 };
    byFP[entry.fingerprint].total += 1;
    if (entry.isWin) byFP[entry.fingerprint].wins += 1;
  }

  const fpStats = Object.entries(byFP)
    .filter(([, s]) => s.total >= 5)
    .map(([fp, s]) => ({ fp, wr: s.wins / s.total, total: s.total }))
    .sort((a, b) => b.wr - a.wr);

  const systemPrompt = `You are a quant analyst. Given market condition performance data, identify the single best and worst performing condition.
Return ONLY JSON: { "bestCondition": "fingerprint string", "worstCondition": "fingerprint string", "insight": "one sentence" }`;

  const userContent = `Condition performance (fingerprint|winRate|sampleCount):\n${
    fpStats.slice(0, 30).map(s => `${s.fp}: wr=${s.wr.toFixed(2)}, n=${s.total}`).join('\n')
  }`;

  const result = await callClaude(systemPrompt, userContent, 512);
  if (!result) return;

  memoryMod.applyConditionWeights(result.bestCondition, result.worstCondition);
  logger.optim('L4', 'Memory analysis complete', { insight: result.insight });
}

// ─── LAYER 5: Self-healing ────────────────────────────────────────────────────
/**
 * Called every tick from index.js. Applies reactive self-healing rules.
 * Returns { action: string } or null.
 */
async function layer5SelfHeal(trades, drawdown, profitFactorWindow) {
  const health = recentTradeHealth(trades, 30);

  // Data-driven anti-chop response:
  // If recent trades are mostly one-candle/stop-loss exits, widen and slow entries.
  if (health.count >= 12 && (health.fastStopRate >= 0.45 || health.stopLossRate >= 0.70 || health.winRate <= 0.15)) {
    const lastTuneAt = Number(_state.lastStopoutTuningAt || 0);
    const tuneCooldownMs = 15 * 60 * 1000;
    if (Date.now() - lastTuneAt >= tuneCooldownMs) {
      const before = {
        atrMultiplier: _state.params.atrMultiplier,
        cooldownCandles: _state.params.cooldownCandles,
        minHoldCandles: _state.params.minHoldCandles,
        momentumThreshold: _state.params.momentumThreshold,
      };

      _state.params.atrMultiplier = Math.min(3.0, Math.max(2.5, Number(_state.params.atrMultiplier || 2.5) + 0.2));
      _state.params.cooldownCandles = Math.min(20, Math.max(8, Number(_state.params.cooldownCandles || 10) + 2));
      _state.params.minHoldCandles = Math.min(10, Math.max(6, Number(_state.params.minHoldCandles || 5) + 1));
      _state.params.momentumThreshold = Math.min(0.008, Number(_state.params.momentumThreshold || 0.003) + 0.0004);
      _state.lastStopoutTuningAt = Date.now();

      const worstSymbols = Object.entries(health.bySymbol)
        .filter(([, s]) => s.total >= 3)
        .map(([sym, s]) => ({
          symbol: sym,
          lossRate: s.losses / s.total,
          fastRate: s.fastStops / s.total,
          pnl: s.pnl,
        }))
        .filter(s => s.lossRate >= 0.80 && s.fastRate >= 0.50)
        .sort((a, b) => a.pnl - b.pnl)
        .slice(0, 2);

      if (_state.instruments) {
        for (const row of worstSymbols) {
          _state.instruments[row.symbol] = _state.instruments[row.symbol] || {};
          _state.instruments[row.symbol].enabled = false;
          _state.instruments[row.symbol].disabledUntil = Date.now() + 60 * 60 * 1000;
        }
      }

      logger.warn('L5', 'Data-driven stopout mitigation applied', {
        health: {
          count: health.count,
          winRate: Number(health.winRate.toFixed(3)),
          stopLossRate: Number(health.stopLossRate.toFixed(3)),
          fastStopRate: Number(health.fastStopRate.toFixed(3)),
        },
        before,
        after: {
          atrMultiplier: _state.params.atrMultiplier,
          cooldownCandles: _state.params.cooldownCandles,
          minHoldCandles: _state.params.minHoldCandles,
          momentumThreshold: _state.params.momentumThreshold,
        },
        temporarilyDisabled: worstSymbols,
      });
    }
  }

  // ── Profit factor drop below 0.8 in any 30-min window ─────────────────────
  if (profitFactorWindow !== null && profitFactorWindow < 0.8) {
    const newRisk = Math.max(1, _state.params.riskPercent * 0.5);
    if (_state.params.riskPercent !== newRisk) {
      logger.warn('L5', `PF < 0.8 — cutting risk in half`, {
        pf: profitFactorWindow.toFixed(3), from: _state.params.riskPercent, to: newRisk,
      });
      _state.params.riskPercent = newRisk;
    }
  }

  // ── Drawdown hit 8% → observation mode for 15 minutes ────────────────────
  if (drawdown >= 0.08 && _state.mode === 'normal') {
    _state.mode   = 'observation';
    _state.observationUntil = Date.now() + 15 * 60 * 1000;
    logger.warn('L5', `Drawdown hit 8% — observation mode for 15 minutes`, { drawdown: (drawdown * 100).toFixed(1) + '%' });
    return { action: 'observation_start' };
  }

  // Resume from observation if time has elapsed
  if (_state.mode === 'observation' && _state.observationUntil && Date.now() > _state.observationUntil) {
    _state.mode = 'normal';
    delete _state.observationUntil;
    logger.optim('L5', 'Observation period ended — resuming normal trading');
  }

  // ── Drawdown hits 12% → full stop, AI strategy reset ─────────────────────
  if (drawdown >= 0.12 && _state.mode !== 'paused') {
    _state.mode = 'paused';
    logger.warn('L5', 'HARD STOP: drawdown ≥ 12% — requesting AI strategy reset');
    await emergencyReset(trades);
    return { action: 'emergency_reset' };
  }

  // Keep minScore pinned to 3 to preserve desired trade frequency profile.
  if (_state.params.minScore !== 3) {
    _state.params.minScore = 3;
  }

  return null;
}

// ─── Emergency reset ──────────────────────────────────────────────────────────
async function emergencyReset(trades) {
  const stats = recentTradeStats(trades, Math.min(trades.length, 100));

  const systemPrompt = `You are a crisis quant analyst. The paper trading bot has hit its maximum drawdown.
Recommend a COMPLETE strategy reset with new parameter values to restart trading safely.
Return ONLY JSON with new parameter values and brief reasons:
{
  "riskPercent":       { "value": number,  "reason": string },
  "atrMultiplier":     { "value": number,  "reason": string },
  "minScore":          { "value": number,  "reason": string },
  "momentumThreshold": { "value": number,  "reason": string },
  "rsiBuyLevel":       { "value": number,  "reason": string },
  "rsiSellLevel":      { "value": number,  "reason": string },
  "cooldownCandles":   { "value": number,  "reason": string },
  "minHoldCandles":    { "value": number,  "reason": string },
  "summary":           string
}`;

  const userContent  = `Emergency state: ${JSON.stringify(stats)}\nCurrent params: ${JSON.stringify(_state.params)}`;
  const result       = await callClaude(systemPrompt, userContent, 1024);

  const defaults = {
    riskPercent: 2.5, atrMultiplier: 2.5, minScore: 3,
    momentumThreshold: 0.003, rsiBuyLevel: 28, rsiSellLevel: 72,
    cooldownCandles: 15, minHoldCandles: 7,
  };

  const resetInsight = {
    timestamp: new Date().toISOString(),
    type:      'emergency_reset',
    stats,
    aiResult:  result,
    appliedParams: {},
  };

  const PARAM_BOUNDS = {
    riskPercent: [1, 3], atrMultiplier: [2.5, 3], minScore: [3, 3],
    momentumThreshold: [0.001, 0.006], rsiBuyLevel: [22, 35],
    rsiSellLevel: [65, 78], cooldownCandles: [10, 20], minHoldCandles: [5, 10],
  };

  for (const [key, def] of Object.entries(defaults)) {
    const upd = result && result[key];
    let val;
    if (upd && typeof upd === 'object' && upd.value !== undefined) {
      const [lo, hi] = PARAM_BOUNDS[key] || [0, 100];
      val = Math.max(lo, Math.min(hi, Number(upd.value)));
      if (isNaN(val)) val = def;
    } else {
      val = def;
    }
    _state.params[key] = val;
    resetInsight.appliedParams[key] = val;
  }

  // Resume with half the risk
  _state.params.riskPercent = Math.min(_state.params.riskPercent, 2.5);
  _state.mode = 'normal';
  _state.peakCapital = _state.capital;  // reset drawdown reference

  const insights = logger.readJSON('insights.json', []);
  insights.push(resetInsight);
  logger.writeJSON('insights.json', insights);

  logger.optim('L5', 'Emergency reset complete — resuming with conservative params', resetInsight.appliedParams);
}

// ─── Timer bootstrap — called from index.js ───────────────────────────────────
function startTimers(getTradesFn, getInstrumentsFn, getOptimsFn) {
  // Layer 1: every 5 minutes
  setInterval(async () => {
    try { await layer1Fast(getTradesFn()); }
    catch (err) { logger.error('L1', err.message); }
  }, 5 * 60 * 1000);

  // Layer 2: every 30 minutes
  setInterval(async () => {
    try { await layer2Medium(getTradesFn(), getInstrumentsFn()); }
    catch (err) { logger.error('L2', err.message); }
  }, 30 * 60 * 1000);

  // Layer 3: every 2 hours
  setInterval(async () => {
    try { await layer3Deep(getTradesFn(), getOptimsFn()); }
    catch (err) { logger.error('L3', err.message); }
  }, 2 * 60 * 60 * 1000);
}

async function evaluatePaperReadiness(payload) {
  const systemPrompt = 'You are a quant trading analyst. Analyze this 24-hour paper trading report and answer if bot is ready for live trading. Return ONLY JSON: {"verdict":"READY|NOT_READY","analysis":"full analysis"}';
  const result = await callClaude(systemPrompt, JSON.stringify(payload), 1200);
  return result;
}

module.exports = {
  init,
  startTimers,
  layer1Fast,
  layer2Medium,
  layer3Deep,
  layer4Memory,
  layer5SelfHeal,
  emergencyReset,
  recentTradeStats,
  evaluatePaperReadiness,
};
