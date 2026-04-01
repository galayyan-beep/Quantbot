'use strict';

/**
 * indicators.js — Pure technical-analysis calculations.
 *
 * All functions are stateless and operate on plain arrays / candle objects.
 * candle = { open, high, low, close, volume, timestamp }
 */

// ─── EMA ─────────────────────────────────────────────────────────────────────
function ema(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` bars
  let val = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    val = prices[i] * k + val * (1 - k);
  }
  return val;
}

// Return the full EMA series (array of same length as prices, null-padded at start)
function emaSeries(prices, period) {
  if (!prices || prices.length < period) return prices.map(() => null);
  const k   = 2 / (period + 1);
  const out  = new Array(prices.length).fill(null);
  let val    = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = val;
  for (let i = period; i < prices.length; i++) {
    val  = prices[i] * k + val * (1 - k);
    out[i] = val;
  }
  return out;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────
function rsi(prices, period = 7) {
  if (!prices || prices.length < period + 1) return null;
  const slice = prices.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ─── VWAP ─────────────────────────────────────────────────────────────────────
function vwap(candles) {
  if (!candles || candles.length === 0) return null;
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV  += tp * c.volume;
    cumVol  += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────
function bollingerBands(prices, period = 15, stdMult = 2) {
  if (!prices || prices.length < period) return null;
  const slice  = prices.slice(-period);
  const mean   = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, p) => s + (p - mean) ** 2, 0) / period;
  const stdDev  = Math.sqrt(variance);
  return {
    upper:     mean + stdMult * stdDev,
    middle:    mean,
    lower:     mean - stdMult * stdDev,
    bandwidth: mean > 0 ? (stdMult * 2 * stdDev) / mean : 0,
  };
}

// ─── MACD ─────────────────────────────────────────────────────────────────────
// Returns { macd, signal, histogram } or null if insufficient data.
function macd(prices, fast = 5, slow = 13, signalPeriod = 4) {
  if (!prices || prices.length < slow + signalPeriod) return null;

  // Build history of (fastEMA - slowEMA) for each bar from `slow-1` onward
  const macdLine = [];
  for (let i = slow; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const fe    = ema(slice, fast);
    const se    = ema(slice, slow);
    if (fe !== null && se !== null) macdLine.push(fe - se);
  }

  const signalLine = ema(macdLine, signalPeriod);
  const lastMacd   = macdLine[macdLine.length - 1];
  return {
    macd:      lastMacd,
    signal:    signalLine,
    histogram: signalLine !== null ? lastMacd - signalLine : null,
    prevHistogram: macdLine.length >= 2 && signalLine !== null
      ? macdLine[macdLine.length - 2] - ema(macdLine.slice(0, -1), signalPeriod)
      : null,
  };
}

// ─── ATR ─────────────────────────────────────────────────────────────────────
function atr(candles, period = 7) {
  if (!candles || candles.length < period + 1) return null;
  const recent = candles.slice(-(period + 1));
  const trs = [];
  for (let i = 1; i < recent.length; i++) {
    const hl  = recent[i].high - recent[i].low;
    const hpc = Math.abs(recent[i].high - recent[i - 1].close);
    const lpc = Math.abs(recent[i].low  - recent[i - 1].close);
    trs.push(Math.max(hl, hpc, lpc));
  }
  return trs.reduce((a, b) => a + b, 0) / period;
}

// ─── Momentum (Rate of Change) ───────────────────────────────────────────────
function momentum(prices, period = 3) {
  if (!prices || prices.length < period + 1) return null;
  const cur  = prices[prices.length - 1];
  const past = prices[prices.length - 1 - period];
  return past !== 0 ? (cur - past) / past : null;
}

// ─── calculateAll ─────────────────────────────────────────────────────────────
/**
 * Compute all indicators for a single symbol's candle history.
 *
 * @param {Array}  candles          Full candle history (OHLCV)
 * @param {number} sessionStartIdx  Index where the current session started
 *                                  (for VWAP reset)
 * @returns {Object|null}           All indicator values, or null if insufficient data
 */
function calculateAll(candles, sessionStartIdx = 0) {
  if (!candles || candles.length < 2) return null;

  const closes  = candles.map(c => c.close);
  const sessionCandles = candles.slice(sessionStartIdx);

  // ── EMAs ───────────────────────────────────────────────────────────────────
  const ema3  = ema(closes, 3);
  const ema8  = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);

  // Previous values (for crossover detection): use all-but-last-candle slice
  const prevCloses = closes.slice(0, -1);
  const prevEma3   = prevCloses.length >= 3  ? ema(prevCloses, 3)  : null;
  const prevEma8   = prevCloses.length >= 8  ? ema(prevCloses, 8)  : null;

  // ── RSI ────────────────────────────────────────────────────────────────────
  const rsi7     = rsi(closes, 7);
  const prevRsi7 = prevCloses.length >= 8 ? rsi(prevCloses, 7) : null;

  // ── VWAP ───────────────────────────────────────────────────────────────────
  const vwapVal  = vwap(sessionCandles.length > 0 ? sessionCandles : candles);

  // ── Bollinger Bands ────────────────────────────────────────────────────────
  const bb       = bollingerBands(closes, 15, 2);

  // Previous bandwidth for squeeze detection
  const prevBB   = prevCloses.length >= 15 ? bollingerBands(prevCloses, 15, 2) : null;

  // ── MACD ───────────────────────────────────────────────────────────────────
  const macdVal  = macd(closes, 5, 13, 4);

  // ── ATR ────────────────────────────────────────────────────────────────────
  const atr7     = atr(candles, 7);

  // ── Momentum ───────────────────────────────────────────────────────────────
  const mom3     = momentum(closes, 3);

  // ── Previous close (for VWAP cross detection) ──────────────────────────────
  const prevClose = candles.length >= 2 ? candles[candles.length - 2].close : null;

  // ── Volume stats for signal strength filtering ──────────────────────────
  const volumes = candles.map(c => c.volume || 0);
  const recentVol = volumes.slice(-1)[0] || 0;
  const avgVol = volumes.length >= 10
    ? volumes.slice(-10).reduce((a, b) => a + b, 0) / 10
    : recentVol || 1;

  return {
    ema3, ema8, ema21, ema50,
    prevEma3, prevEma8,
    rsi7, prevRsi7,
    vwap: vwapVal,
    bb, prevBB,
    macd: macdVal,
    atr7,
    momentum3: mom3,
    prevClose,
    close: closes[closes.length - 1],
    volume: recentVol,
    avgVolume: avgVol,
  };
}

module.exports = {
  ema, emaSeries, rsi, vwap, bollingerBands, macd, atr, momentum, calculateAll,
};
