'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const logger = require('./logger');
const { CapitalClient } = require('./capitalApi');

const ROOT = __dirname;
const PORT = Number(process.env.DASHBOARD_PORT || 8787);

let capitalClient = null;
let capitalCache = { fetchedAt: 0, value: null };

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload, null, 2));
}

function getCapitalClient() {
  if (!capitalClient) {
    capitalClient = new CapitalClient({ paperTrading: false });
  }
  return capitalClient;
}

async function fetchCapitalLive() {
  const now = Date.now();
  if (capitalCache.value && now - capitalCache.fetchedAt < 8000) {
    return capitalCache.value;
  }

  const client = getCapitalClient();
  try {
    const [account, positions] = await Promise.all([
      client.getAccountSnapshot(),
      client.getOpenPositions(),
    ]);
    const payload = {
      ok: true,
      fetchedAt: now,
      capitalAccount: {
        ...(account || {}),
        positions: positions?.positions || [],
      },
    };
    capitalCache = { fetchedAt: now, value: payload };
    return payload;
  } catch (err) {
    logger.warn('DASH', 'Live Capital fetch failed', { error: err.message });
    const payload = {
      ok: false,
      fetchedAt: now,
      error: err.message,
      capitalAccount: {
        connected: false,
        positions: [],
      },
    };
    capitalCache = { fetchedAt: now, value: payload };
    return payload;
  }
}

function safePath(urlPath) {
  const clean = decodeURIComponent(String(urlPath || '/').split('?')[0]);
  const normalized = path.normalize(clean).replace(/^(\.\.(\/|\\|$))+/, '');
  const resolved = path.join(ROOT, normalized === '/' ? 'dashboard.html' : normalized.replace(/^\//, ''));
  if (!resolved.startsWith(ROOT)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    return sendJson(res, 200, { ok: true, service: 'dashboard-server' });
  }

  if (req.url && req.url.startsWith('/api/capital-live')) {
    fetchCapitalLive()
      .then(payload => sendJson(res, 200, payload))
      .catch(err => sendJson(res, 500, { ok: false, error: err.message }));
    return;
  }

  const filePath = safePath(req.url === '/' ? '/dashboard.html' : req.url);
  if (!filePath) {
    return sendJson(res, 400, { ok: false, error: 'Invalid path' });
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        return sendJson(res, 404, { ok: false, error: 'Not found' });
      }
      logger.error('DASH', 'Failed to serve file', { filePath, error: err.message });
      return sendJson(res, 500, { ok: false, error: 'Failed to read file' });
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.json' ? 'no-store' : 'no-cache',
    });
    res.end(content);
  });
});

server.listen(PORT, () => {
  logger.info('DASH', 'Dashboard server listening', { port: PORT, url: `http://localhost:${PORT}` });
});