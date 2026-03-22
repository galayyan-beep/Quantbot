'use strict';

const logger = require('./logger');
const Anthropic = require('@anthropic-ai/sdk');

let matrixState = {
  updatedAt: 0,
  matrix: {},
  volatility: {},
};

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

function pearson(a, b) {
  if (!a.length || a.length !== b.length) return 0;
  const n = a.length;
  const meanA = a.reduce((x, y) => x + y, 0) / n;
  const meanB = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

function returnsFromCandles(candles, n = 30) {
  if (!candles || candles.length < n + 1) return [];
  const c = candles.slice(-(n + 1));
  const out = [];
  for (let i = 1; i < c.length; i++) {
    const prev = c[i - 1].close;
    const cur = c[i].close;
    out.push(prev ? (cur - prev) / prev : 0);
  }
  return out;
}

function update(candleHistory) {
  const symbols = Object.keys(candleHistory || {});
  const rets = {};
  const vols = {};
  for (const s of symbols) {
    rets[s] = returnsFromCandles(candleHistory[s], 30);
    if (rets[s].length) {
      const mean = rets[s].reduce((a, b) => a + b, 0) / rets[s].length;
      const variance = rets[s].reduce((a, b) => a + ((b - mean) ** 2), 0) / rets[s].length;
      vols[s] = Math.sqrt(variance);
    } else {
      vols[s] = 0.01;
    }
  }

  const matrix = {};
  for (const a of symbols) {
    matrix[a] = {};
    for (const b of symbols) {
      if (a === b) matrix[a][b] = 1;
      else matrix[a][b] = Number(pearson(rets[a], rets[b]).toFixed(4));
    }
  }

  matrixState = {
    updatedAt: Date.now(),
    matrix,
    volatility: vols,
  };

  logger.writeJSON('correlation.json', matrixState);
  return matrixState;
}

function correlation(a, b) {
  return matrixState.matrix?.[a]?.[b] ?? 0;
}

function canOpen(symbol, openPositions) {
  for (const openSym of Object.keys(openPositions || {})) {
    const corr = correlation(symbol, openSym);
    if (corr > 0.7) {
      return { allowed: false, reason: `Correlation ${corr.toFixed(2)} with ${openSym} > 0.7`, coefficient: corr, other: openSym };
    }
  }
  return { allowed: true, reason: 'OK', coefficient: 0 };
}

function positionVolMultiplier(symbol) {
  const vol = matrixState.volatility?.[symbol] || 0.01;
  const inv = 1 / Math.max(vol, 0.0001);
  const normalized = Math.max(0.5, Math.min(1.8, inv / 100));
  return normalized;
}

function portfolioCorrelationRisk(openPositions) {
  const syms = Object.keys(openPositions || {});
  if (syms.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      total += Math.abs(correlation(syms[i], syms[j]));
      pairs++;
    }
  }
  const avgCorr = pairs ? total / pairs : 0;
  const grossRisk = Object.values(openPositions).reduce((s, p) => s + (p.riskAmount || 0), 0);
  return grossRisk * (1 + avgCorr);
}

function enforceOpenPositionCorrelation(state, executor) {
  const entries = Object.values(state.openPositions || {});
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const corr = correlation(a.symbol, b.symbol);
      if (corr > 0.8) {
        const newer = a.entryTime > b.entryTime ? a : b;
        logger.warn('CORREL', 'Closing newer position due to high live correlation', {
          symbol: newer.symbol,
          against: newer.symbol === a.symbol ? b.symbol : a.symbol,
          coefficient: corr,
        });
        executor.exit(newer.symbol, 'correlation_forced_exit');
      }
    }
  }
}

function startHourly(candleHistory) {
  update(candleHistory);
  setInterval(() => {
    update(candleHistory);
  }, 60 * 60 * 1000);

  setInterval(async () => {
    const c = getClient();
    if (!c) return;
    try {
      const prompt = 'Analyze this correlation matrix for concentration risk. Return ONLY JSON {"riskLevel":"LOW|MEDIUM|HIGH","summary":"..."}';
      const res = await c.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
        max_tokens: 220,
        messages: [{ role: 'user', content: `${prompt}\n\n${JSON.stringify(matrixState)}` }],
      });
      const text = res.content[0]?.text || '{}';
      const m = text.match(/\{[\s\S]*\}/);
      const parsed = m ? JSON.parse(m[0]) : { riskLevel: 'UNKNOWN', summary: 'No response' };
      matrixState.concentrationRisk = parsed;
      logger.writeJSON('correlation.json', matrixState);
      logger.optim('CORREL', 'Concentration risk review updated', parsed);
    } catch (err) {
      logger.warn('CORREL', 'Concentration risk review failed', { error: err.message });
    }
  }, 2 * 60 * 60 * 1000);
}

function getState() {
  return matrixState;
}

module.exports = {
  startHourly,
  update,
  getState,
  canOpen,
  correlation,
  positionVolMultiplier,
  portfolioCorrelationRisk,
  enforceOpenPositionCorrelation,
};
