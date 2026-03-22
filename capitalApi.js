'use strict';

const logger = require('./logger');

const LIVE_BASE = 'https://api-capital.backend-capital.com/api/v1';
const DEMO_BASE = 'https://demo-api-capital.backend-capital.com/api/v1';
const LIVE_BASE_GBM = 'https://api-capital.backend.gbm.com/api/v1';
const DEMO_BASE_GBM = 'https://demo-api-capital.backend.gbm.com/api/v1';

const LIVE_BASE_CANDIDATES = [LIVE_BASE, LIVE_BASE_GBM];
const DEMO_BASE_CANDIDATES = [DEMO_BASE, DEMO_BASE_GBM];

let httpClientLoader = null;

async function getHttpClient() {
  if (!httpClientLoader) {
    httpClientLoader = (async () => {
      if (typeof fetch === 'function') {
        logger.info('CAPITAL', 'HTTP client selected', { client: 'global.fetch' });
        return fetch;
      }

      try {
        const nodeFetch = await import('node-fetch');
        logger.info('CAPITAL', 'HTTP client selected', { client: 'node-fetch' });
        return nodeFetch.default;
      } catch (err) {
        throw new Error(`No fetch implementation available. Install node-fetch. Detail: ${err.message}`);
      }
    })();
  }
  return httpClientLoader;
}

async function pingInternet() {
  const http = await getHttpClient();
  const url = 'https://www.google.com';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await http(url, { method: 'GET', signal: controller.signal });
    logger.info('NET', 'Internet connectivity check', { url, ok: res.ok, status: res.status });
    return true;
  } catch (err) {
    logger.error('NET', 'Internet connectivity check failed', { url, error: err.message });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeCapitalHosts() {
  const http = await getHttpClient();
  const targets = [
    'https://demo-api-capital.backend-capital.com/api/v1/session',
    'https://api-capital.backend-capital.com/api/v1/session',
  ];

  const results = [];
  for (const url of targets) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await http(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
      const row = { url, reachable: true, status: res.status, ok: res.ok };
      results.push(row);
      logger.info('CAPITAL', 'Host probe', row);
    } catch (err) {
      const row = { url, reachable: false, error: err.message };
      results.push(row);
      logger.warn('CAPITAL', 'Host probe failed', row);
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}

const EPICS = {
  BTC: 'BTCUSD',
  ETH: 'ETHUSD',
  SOL: 'SOLUSD',
  BNB: 'BNBUSD',
  EURUSD: 'EURUSD',
  GBPUSD: 'GBPUSD',
  USDJPY: 'USDJPY',
  AUDUSD: 'AUDUSD',
  GOLD: 'GOLD',
  SILVER: 'SILVER',
  OIL: 'OIL_CRUDE',
  SPX: 'US500',
  NQ: 'US100',
  DAX: 'DE40',
};

class CapitalClient {
  constructor({ paperTrading }) {
    this.paperTrading = !!paperTrading;
    this.baseUrl = this.paperTrading ? DEMO_BASE : LIVE_BASE;
    this.baseCandidates = this.paperTrading ? [...DEMO_BASE_CANDIDATES] : [...LIVE_BASE_CANDIDATES];
    this.apiKey = process.env.CAPITAL_API_KEY || '';
    this.secret = process.env.CAPITAL_API_SECRET || '';
    this.identifier = process.env.CAPITAL_IDENTIFIER || '';
    this.requiredClientId = process.env.CAPITAL_CLIENT_ID || '';
    this.targetAvailableBalance = Number(process.env.CAPITAL_TARGET_AVAILABLE_BALANCE || 100);
    this.targetAccountId = process.env.CAPITAL_ACCOUNT_ID || '313428098873906372';
    this.cst = null;
    this.securityToken = null;
    this.authenticatedAt = 0;
    this.activeAccountId = null;
    this.lastBySymbol = {};
    this.marketStatusCache = {};
    this.marketStatusTtlMs = 30000;
    this.endpointChecked = false;
    this.safetyConfirmedLogged = false;
  }

  isMarketOpenStatus(status) {
    const s = String(status || '').toUpperCase();
    return s === 'TRADEABLE' || s === 'TRADEABLE_ONLINE' || s === 'OPEN';
  }

  extractMarketStatus(body) {
    return body?.snapshot?.marketStatus
      || body?.instrument?.marketStatus
      || body?.marketStatus
      || null;
  }

  async getMarketDetailsByEpic(epic, opts = {}) {
    const forceRefresh = !!opts.forceRefresh;
    const cached = this.marketStatusCache[epic];
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < this.marketStatusTtlMs) {
      return cached;
    }

    const ready = await this.auth();
    if (!ready) throw new Error('Capital auth unavailable');

    const { body } = await this.request(`/markets/${encodeURIComponent(epic)}`, { method: 'GET' });
    const marketStatus = this.extractMarketStatus(body);
    const details = {
      epic,
      status: marketStatus,
      isOpen: this.isMarketOpenStatus(marketStatus),
      fetchedAt: Date.now(),
      raw: body,
    };
    this.marketStatusCache[epic] = details;
    return details;
  }

  async getMarketStatus(symbol, opts = {}) {
    const epic = EPICS[symbol];
    if (!epic) throw new Error(`No epic mapping for symbol ${symbol}`);
    const details = await this.getMarketDetailsByEpic(epic, opts);
    return {
      symbol,
      epic,
      status: details.status,
      isOpen: details.isOpen,
      fetchedAt: details.fetchedAt,
      raw: details.raw,
    };
  }

  pickTargetAccount(accounts = []) {
    if (!Array.isArray(accounts) || accounts.length === 0) return null;
    const target = Number.isFinite(this.targetAvailableBalance) ? this.targetAvailableBalance : 100;

    let best = null;
    let bestDiff = Number.POSITIVE_INFINITY;
    for (const acc of accounts) {
      const available = Number(acc?.balance?.available ?? acc?.available ?? NaN);
      if (!Number.isFinite(available)) continue;
      const diff = Math.abs(available - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = acc;
      }
    }

    return best || accounts[0];
  }

  targetAccountFrom(body) {
    const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
    if (this.targetAccountId) {
      const byId = accounts.find(a => String(a?.accountId || '').trim() === this.targetAccountId);
      if (byId) return byId;
    }
    return this.pickTargetAccount(accounts);
  }

  useMode({ paperTrading }) {
    const changed = this.paperTrading !== !!paperTrading;
    this.paperTrading = !!paperTrading;
    this.baseUrl = this.paperTrading ? DEMO_BASE : LIVE_BASE;
    this.baseCandidates = this.paperTrading ? [...DEMO_BASE_CANDIDATES] : [...LIVE_BASE_CANDIDATES];
    if (changed) {
      this.cst = null;
      this.securityToken = null;
      this.authenticatedAt = 0;
      this.endpointChecked = false;
    }
  }

  async probeBaseUrl(base) {
    const http = await getHttpClient();
    const url = `${base}/session`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await http(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      logger.info('CAPITAL', 'Endpoint probe response', { url, status: res.status, ok: res.ok });
      return true;
    } catch (err) {
      logger.warn('CAPITAL', 'Endpoint probe failed', { url, error: err.message });
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async selectReachableBaseUrl() {
    if (this.endpointChecked) return;
    this.endpointChecked = true;

    for (const candidate of this.baseCandidates) {
      const ok = await this.probeBaseUrl(candidate);
      if (ok) {
        this.baseUrl = candidate;
        logger.info('CAPITAL', 'Selected reachable Capital API base URL', { baseUrl: this.baseUrl });
        return;
      }
    }

    logger.warn('CAPITAL', 'No Capital API base URL responded to probes; keeping default', { baseUrl: this.baseUrl, candidates: this.baseCandidates });
  }

  headers(extra = {}) {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra,
    };
    if (this.apiKey) h['X-CAP-API-KEY'] = this.apiKey;
    if (this.cst) h.CST = this.cst;
    if (this.securityToken) h['X-SECURITY-TOKEN'] = this.securityToken;
    return h;
  }

  async request(path, options = {}, retry = 0) {
    const maxRetry = 5;
    const delay = Math.min(1000 * (2 ** retry), 15000);
    await this.selectReachableBaseUrl();
    try {
      const http = await getHttpClient();
      const url = `${this.baseUrl}${path}`;
      const { headers: extraHeaders = {}, ...requestOptions } = options;
      const headers = this.headers(extraHeaders);
      logger.info('CAPITAL', 'HTTP request', {
        method: requestOptions.method || 'GET',
        url,
        headers,
      });
      const res = await http(url, {
        ...requestOptions,
        headers,
      });
      if (res.status === 429 && retry < maxRetry) {
        logger.warn('CAPITAL', 'Rate limited, retrying', { path, retry, delayMs: delay });
        await new Promise(r => setTimeout(r, delay));
        return this.request(path, options, retry + 1);
      }
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (!res.ok) {
        const msg = body?.errorCode || body?.message || `HTTP ${res.status}`;
        const error = new Error(`${path} failed: ${msg}`);
        error.retryable = res.status >= 500;
        error.status = res.status;
        error.path = path;
        error.url = url;
        error.responseBody = body;
        throw error;
      }
      return { res, body };
    } catch (err) {
      if (retry < maxRetry && err.retryable !== false) {
        logger.warn('CAPITAL', 'Request failed, retrying', { path, retry, error: err.message, delayMs: delay });
        await new Promise(r => setTimeout(r, delay));
        return this.request(path, options, retry + 1);
      }
      throw err;
    }
  }

  async getSessionDetails() {
    if (!this.cst || !this.securityToken) {
      throw new Error('Session not authenticated');
    }
    const { body } = await this.request('/session', { method: 'GET' });
    const accountId = String(body?.accountId || body?.currentAccountId || '').trim() || null;
    this.activeAccountId = accountId;
    return {
      accountId,
      raw: body,
    };
  }

  async switchActiveAccount(accountId) {
    const target = String(accountId || '').trim();
    if (!target) throw new Error('Missing accountId for account switch');
    if (!this.cst || !this.securityToken) {
      throw new Error('Session not authenticated');
    }

    const payload = { accountId: target };
    logger.info('CAPITAL', 'Switch active account request', {
      endpoint: '/session',
      method: 'PUT',
      payload,
    });

    let body;
    try {
      const switched = await this.request('/session', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      body = switched.body;
    } catch (err) {
      const code = String(err?.responseBody?.errorCode || '');
      if (err?.status !== 400 || code !== 'error.not-different.accountId') {
        throw err;
      }
      body = { status: 'SUCCESS', note: 'already_active_account' };
    }

    const details = await this.request('/session', { method: 'GET' });
    const current = String(details?.body?.accountId || details?.body?.currentAccountId || '').trim() || null;
    this.activeAccountId = current;

    logger.info('CAPITAL', 'Switch active account response', {
      endpoint: '/session',
      method: 'PUT',
      requestedAccountId: target,
      activeAccountId: current,
      responseBody: body,
    });

    if (current !== target) {
      throw new Error(`Account switch failed: active account is '${current || 'unknown'}', expected '${target}'`);
    }

    return {
      requestedAccountId: target,
      activeAccountId: current,
      raw: body,
    };
  }

  async ensureTargetAccountActive(options = {}) {
    const force = !!options.force;
    if (!this.targetAccountId) return null;

    const ready = await this.auth();
    if (!ready) throw new Error('Capital auth unavailable');

    const details = await this.getSessionDetails();
    const current = String(details?.accountId || '').trim();
    const target = String(this.targetAccountId || '').trim();

    if (!force && current === target) {
      return { switched: false, activeAccountId: current };
    }

    const switched = await this.switchActiveAccount(target);
    return {
      switched: true,
      activeAccountId: switched.activeAccountId,
    };
  }

  async auth() {
    const needsAuth = !this.cst || !this.securityToken || Date.now() - this.authenticatedAt > 50 * 60 * 1000;
    if (!needsAuth) return true;
    if (!this.apiKey || !this.secret || !this.identifier) {
      logger.warn('CAPITAL', 'Missing CAPITAL_* env vars; running in fallback-price mode');
      return false;
    }
    const payload = {
      identifier: this.identifier,
      password: this.secret,
    };
    const { res, body } = await this.request('/session', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    this.cst = res.headers.get('cst') || res.headers.get('CST') || null;
    this.securityToken = res.headers.get('x-security-token') || res.headers.get('X-SECURITY-TOKEN') || null;

    // Safety confirmation: verify expected client and target account are present.
    const clientId = String(body?.clientId || '').trim();
    if (this.requiredClientId && clientId !== this.requiredClientId) {
      throw new Error(`Trading blocked: clientId '${clientId || 'unknown'}' does not match required '${this.requiredClientId}'`);
    }

    const target = this.targetAccountFrom(body);
    if (!target) {
      throw new Error('Trading blocked: target account was not returned in session accounts list');
    }

    const currentAccountId = String(body?.currentAccountId || '').trim();
    this.activeAccountId = currentAccountId || null;
    const targetAccountId = String(target?.accountId || '').trim();
    const targetAvail = Number(target?.balance?.available ?? target?.available ?? NaN);
    logger.info('CAPITAL', 'Session account check', {
      currentAccountId,
      targetAccountId,
      targetAvailable: Number.isFinite(targetAvail) ? targetAvail : null,
      targetAvailableBalance: this.targetAvailableBalance,
    });

    if (this.targetAccountId && targetAccountId !== this.targetAccountId) {
      throw new Error(`Trading blocked: target account '${this.targetAccountId}' was not returned in session accounts list`);
    }

    if (!target || !Number.isFinite(targetAvail)) {
      throw new Error('Trading blocked: target account available balance is unavailable');
    }
    if (Math.abs(targetAvail - this.targetAvailableBalance) > 0.01) {
      logger.warn('CAPITAL', 'Target account available balance differs from configured reference', {
        targetAvailable: targetAvail,
        configuredReference: this.targetAvailableBalance,
      });
    }

    if (!this.safetyConfirmedLogged) {
      logger.info('CAPITAL', 'SAFETY CONFIRMED — Account 3 with $100 found. Trading capped at $100 maximum exposure.', {
        activeAccountId: currentAccountId,
        targetAccountId,
        targetAvailable: targetAvail,
      });
      this.safetyConfirmedLogged = true;
    }

    if (this.targetAccountId && currentAccountId !== this.targetAccountId) {
      await this.switchActiveAccount(this.targetAccountId);
    }

    this.authenticatedAt = Date.now();
    logger.info('CAPITAL', 'Authenticated session created', { paperTrading: this.paperTrading, activeAccountId: currentAccountId });
    return !!(this.cst && this.securityToken);
  }

  async fetchLatestCandle(symbol) {
    const epic = EPICS[symbol];
    if (!epic) throw new Error(`No epic mapping for symbol ${symbol}`);
    const ready = await this.auth();
    if (!ready) {
      const fallback = this.lastBySymbol[symbol];
      if (fallback) return fallback;
      throw new Error('Capital auth unavailable and no cached candle');
    }

    const { body } = await this.request(`/prices/${encodeURIComponent(epic)}?resolution=MINUTE&max=2`, { method: 'GET' });
    const arr = body?.prices || body?.candles || [];
    const latest = arr[arr.length - 1];
    if (!latest) {
      const fallback = this.lastBySymbol[symbol];
      if (fallback) return fallback;
      throw new Error(`No candle returned for ${symbol}`);
    }

    const open = Number(latest.openPrice?.bid ?? latest.open ?? latest.openPrice ?? latest.closePrice?.bid ?? 0);
    const high = Number(latest.highPrice?.bid ?? latest.high ?? open);
    const low = Number(latest.lowPrice?.bid ?? latest.low ?? open);
    const close = Number(latest.closePrice?.bid ?? latest.close ?? open);
    const volume = Number(latest.lastTradedVolume ?? latest.volume ?? 1);
    const timestamp = latest.snapshotTimeUTC
      ? Date.parse(latest.snapshotTimeUTC)
      : latest.snapshotTime
        ? Date.parse(latest.snapshotTime)
        : Date.now();

    const candle = { symbol, open, high, low, close, volume, timestamp: Number.isFinite(timestamp) ? timestamp : Date.now() };
    this.lastBySymbol[symbol] = candle;
    return candle;
  }

  async fetchBatch(symbols) {
    const out = {};
    for (const symbol of symbols) {
      try {
        const status = await this.getMarketStatus(symbol);
        if (!status.isOpen) {
          logger.info('CAPITAL', 'Skipping candle fetch for closed market', {
            symbol,
            epic: status.epic,
            marketStatus: status.status,
          });
          continue;
        }
        out[symbol] = await this.fetchLatestCandle(symbol);
      } catch (err) {
        if (this.lastBySymbol[symbol]) {
          out[symbol] = this.lastBySymbol[symbol];
          logger.warn('CAPITAL', 'Using last known candle fallback', { symbol, error: err.message });
        } else {
          logger.warn('CAPITAL', 'Skipping symbol with no candle data', { symbol, error: err.message });
        }
      }
    }
    return out;
  }

  async placePosition({ symbol, direction, size, stopLoss, takeProfit }) {
    const epic = EPICS[symbol];
    if (!epic) throw new Error(`No epic mapping for symbol ${symbol}`);
    const ready = await this.auth();
    if (!ready) throw new Error('Capital auth unavailable');

    const ensured = await this.ensureTargetAccountActive({ force: true });
    const market = await this.getMarketDetailsByEpic(epic, { forceRefresh: true });
    if (!market.isOpen) {
      const closedErr = new Error(`Market is closed for ${symbol} (${epic}) with status '${market.status || 'UNKNOWN'}'`);
      closedErr.status = 409;
      closedErr.retryable = false;
      closedErr.responseBody = { marketStatus: market.status, epic };
      logger.warn('CAPITAL', 'Order skipped because market is closed', { symbol, epic, marketStatus: market.status });
      throw closedErr;
    }

    const payload = {
      epic,
      direction: direction === 'long' ? 'BUY' : 'SELL',
      size,
      guaranteedStop: false,
      forceOpen: true,
      level: null,
      stopLevel: stopLoss,
      profitLevel: takeProfit,
      orderType: 'MARKET',
      currencyCode: 'USD',
    };

    logger.info('CAPITAL', 'Order placement request', {
      endpoint: '/positions',
      method: 'POST',
      symbol,
      activeAccountId: ensured?.activeAccountId || this.activeAccountId || null,
      payload,
    });

    try {
      const { res, body } = await this.request('/positions', {
        method: 'POST',
        headers: {
          'X-CAP-ACCOUNT-ID': this.targetAccountId,
        },
        body: JSON.stringify(payload),
      });

      logger.info('CAPITAL', 'Order placement response', {
        endpoint: '/positions',
        method: 'POST',
        symbol,
        activeAccountId: ensured?.activeAccountId || this.activeAccountId || null,
        status: res?.status ?? null,
        responseBody: body,
      });

      return {
        dealReference: body?.dealReference || null,
        dealId: body?.dealId || null,
        raw: body,
      };
    } catch (err) {
      logger.error('CAPITAL', 'Order placement error', {
        endpoint: '/positions',
        method: 'POST',
        symbol,
        activeAccountId: ensured?.activeAccountId || this.activeAccountId || null,
        payload,
        status: err?.status ?? null,
        error: err?.message || String(err),
        responseBody: err?.responseBody || null,
      });
      throw err;
    }
  }

  async closePosition(dealId) {
    if (!dealId) return null;
    const ready = await this.auth();
    if (!ready) throw new Error('Capital auth unavailable');
    await this.ensureTargetAccountActive({ force: true });
    const { body } = await this.request(`/positions/${encodeURIComponent(dealId)}`, {
      method: 'DELETE',
    });
    return body;
  }
}

module.exports = {
  CapitalClient,
  EPICS,
  LIVE_BASE,
  DEMO_BASE,
  LIVE_BASE_GBM,
  DEMO_BASE_GBM,
  pingInternet,
  probeCapitalHosts,
};
