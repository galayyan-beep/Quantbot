'use strict';

const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists at module load time
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ─── Timestamp ───────────────────────────────────────────────────────────────
function ts() {
  return new Date().toISOString();
}

// ─── Core log printer ────────────────────────────────────────────────────────
function log(level, module, message, data) {
  const dataStr = data !== undefined ? ' ' + JSON.stringify(data) : '';
  const line = `[${ts()}] [${level.padEnd(5)}] [${module.padEnd(9)}] ${message}${dataStr}`;
  console.log(line);
}

// ─── Named log levels ────────────────────────────────────────────────────────
const info  = (mod, msg, data) => log('INFO',  mod, msg, data);
const warn  = (mod, msg, data) => log('WARN',  mod, msg, data);
const error = (mod, msg, data) => log('ERROR', mod, msg, data);
const trade = (mod, msg, data) => log('TRADE', mod, msg, data);
const optim = (mod, msg, data) => log('OPTIM', mod, msg, data);
const debug = (mod, msg, data) => log('DEBUG', mod, msg, data);

// ─── JSON persistence ────────────────────────────────────────────────────────
function writeJSON(filename, data) {
  try {
    const tmpPath = path.join(DATA_DIR, filename + '.tmp');
    const finalPath = path.join(DATA_DIR, filename);
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, finalPath);          // atomic write
  } catch (err) {
    error('LOGGER', `Failed to write ${filename}`, { error: err.message });
  }
}

function readJSON(filename, defaultValue = null) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    error('LOGGER', `Failed to read ${filename}`, { error: err.message });
  }
  return defaultValue;
}

function appendJSON(filename, entry) {
  const arr = readJSON(filename, []);
  arr.push(entry);
  writeJSON(filename, arr);
}

module.exports = { info, warn, error, trade, optim, debug, writeJSON, readJSON, appendJSON, ts };
