'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./logger');

const NEWS_URL = 'https://newsapi.org/v2/everything';
const TERMS = [
  'Bitcoin', 'Ethereum', 'Solana', 'BNB',
  'Euro Dollar', 'British Pound', 'Japanese Yen', 'Australian Dollar',
  'Gold price', 'Silver price', 'Crude Oil',
  'S&P 500', 'Nasdaq', 'DAX',
];

const TERM_TO_SYMBOLS = {
  Bitcoin: ['BTC'],
  Ethereum: ['ETH'],
  Solana: ['SOL'],
  BNB: ['BNB'],
  'Euro Dollar': ['EURUSD'],
  'British Pound': ['GBPUSD'],
  'Japanese Yen': ['USDJPY'],
  'Australian Dollar': ['AUDUSD'],
  'Gold price': ['GOLD'],
  'Silver price': ['SILVER'],
  'Crude Oil': ['OIL'],
  'S&P 500': ['SPX'],
  Nasdaq: ['NQ'],
  DAX: ['DAX'],
};

const CLASS_SCORE = {
  VERY_BULLISH: 2,
  BULLISH: 1,
  NEUTRAL: 0,
  BEARISH: -1,
  VERY_BEARISH: -2,
};

let state = {
  updatedAt: 0,
  overall: {},
  bySymbol: {},
  headlines: [],
};

let _client = null;
function client() {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  _client = new Anthropic({ apiKey: key });
  return _client;
}

function decay() {
  for (const sym of Object.keys(state.bySymbol)) {
    state.bySymbol[sym] = Number((state.bySymbol[sym] * 0.9).toFixed(4));
  }
}

async function classifyHeadline(title) {
  const c = client();
  if (!c) return { label: 'NEUTRAL', confidence: 0.5, reason: 'No API key' };
  const prompt = 'Classify this financial headline sentiment as VERY_BULLISH, BULLISH, NEUTRAL, BEARISH, or VERY_BEARISH. Return ONLY JSON {"label":"...","confidence":0-1}. Headline: ' + title;
  try {
    const res = await c.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
      max_tokens: 120,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = res.content[0]?.text || '{}';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { label: 'NEUTRAL', confidence: 0.5 };
    const parsed = JSON.parse(m[0]);
    const label = CLASS_SCORE[parsed.label] !== undefined ? parsed.label : 'NEUTRAL';
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence || 0.5)));
    return { label, confidence };
  } catch (err) {
    logger.warn('SENTIMENT', 'Headline classification failed', { error: err.message });
    return { label: 'NEUTRAL', confidence: 0.5 };
  }
}

async function fetchHeadlines() {
  const key = process.env.NEWS_API_KEY;
  if (!key) {
    logger.warn('SENTIMENT', 'NEWS_API_KEY missing, sentiment module idle');
    return [];
  }

  const q = encodeURIComponent(TERMS.join(' OR '));
  const url = `${NEWS_URL}?q=${q}&language=en&sortBy=publishedAt&pageSize=50&apiKey=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NewsAPI HTTP ${res.status}`);
  const body = await res.json();
  return body.articles || [];
}

function inferTerms(title = '') {
  const lower = title.toLowerCase();
  return TERMS.filter(t => lower.includes(t.toLowerCase()));
}

async function refresh() {
  decay();
  let articles = [];
  try {
    articles = await fetchHeadlines();
  } catch (err) {
    logger.warn('SENTIMENT', 'Failed to fetch headlines', { error: err.message });
  }

  const latest = [];
  for (const a of articles.slice(0, 25)) {
    const title = String(a.title || '').trim();
    if (!title) continue;
    const terms = inferTerms(title);
    if (!terms.length) continue;

    const cls = await classifyHeadline(title);
    const score = CLASS_SCORE[cls.label] * cls.confidence;

    for (const t of terms) {
      const symbols = TERM_TO_SYMBOLS[t] || [];
      for (const sym of symbols) {
        state.bySymbol[sym] = Number(((state.bySymbol[sym] || 0) + score).toFixed(4));
      }
    }

    latest.push({
      title,
      source: a.source?.name || 'unknown',
      publishedAt: a.publishedAt || new Date().toISOString(),
      label: cls.label,
      confidence: cls.confidence,
      score,
      terms,
    });
  }

  state.headlines = latest;
  state.updatedAt = Date.now();
  state.overall = {
    meanScore: Object.keys(state.bySymbol).length
      ? Number((Object.values(state.bySymbol).reduce((a, b) => a + b, 0) / Object.keys(state.bySymbol).length).toFixed(4))
      : 0,
  };

  logger.writeJSON('sentiment.json', state);
  logger.info('SENTIMENT', 'Sentiment refreshed', { symbols: Object.keys(state.bySymbol).length, headlines: latest.length });
  return state;
}

function scoreFor(symbol) {
  return state.bySymbol[symbol] || 0;
}

function blocksDirection(symbol, direction) {
  const s = scoreFor(symbol);
  if (Math.abs(s) <= 3) return false;
  if (direction === 'long' && s <= -3) return true;
  if (direction === 'short' && s >= 3) return true;
  return false;
}

function applyBias(symbol, longScore, shortScore) {
  const s = scoreFor(symbol);
  let l = longScore;
  let sh = shortScore;
  if (s > 2) l += 1;
  if (s < -2) sh += 1;
  return { longScore: l, shortScore: sh, sentimentScore: s };
}

function start() {
  refresh().catch(err => logger.warn('SENTIMENT', 'Initial refresh failed', { error: err.message }));
  setInterval(() => {
    refresh().catch(err => logger.warn('SENTIMENT', 'Periodic refresh failed', { error: err.message }));
  }, 15 * 60 * 1000);
}

function getState() {
  return state;
}

module.exports = {
  start,
  refresh,
  getState,
  scoreFor,
  blocksDirection,
  applyBias,
};
