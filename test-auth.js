'use strict';

const readline = require('readline');

async function getHttpClient() {
  if (typeof fetch === 'function') return fetch;
  const nodeFetch = await import('node-fetch');
  return nodeFetch.default;
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(String(answer || '').trim())));
}

function askHidden(question) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = '';

    stdout.write(question);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');

    const onData = ch => {
      if (ch === '\r' || ch === '\n') {
        stdout.write('\n');
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        resolve(value.trim());
        return;
      }
      if (ch === '\u0003') {
        stdout.write('\nCancelled\n');
        process.exit(1);
      }
      if (ch === '\u007f') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
        return;
      }
      value += ch;
      stdout.write('*');
    };

    stdin.on('data', onData);
  });
}

async function main() {
  const http = await getHttpClient();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const modeEnv = String(process.env.CAPITAL_MODE || '').toLowerCase();
  const modeInput = modeEnv || (await ask(rl, 'Mode (demo/live) [demo]: ')).toLowerCase();
  const mode = modeInput === 'live' ? 'live' : 'demo';
  const baseUrl = mode === 'live'
    ? 'https://api-capital.backend-capital.com/api/v1'
    : 'https://demo-api-capital.backend-capital.com/api/v1';

  const identifier = String(process.env.CAPITAL_IDENTIFIER || '').trim() || await ask(rl, 'CAPITAL_IDENTIFIER: ');
  rl.close();

  const apiKey = String(process.env.CAPITAL_API_KEY || '').trim() || await askHidden('CAPITAL_API_KEY (hidden): ');
  const secret = String(process.env.CAPITAL_API_SECRET || '').trim() || await askHidden('CAPITAL_API_SECRET / password (hidden): ');

  const payload = {
    identifier,
    password: secret,
  };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-CAP-API-KEY': apiKey,
  };

  const url = `${baseUrl}/session`;
  console.log(`Testing session auth against: ${url}`);

  try {
    const res = await http(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }

    if (res.ok) {
      const cst = res.headers.get('cst') || res.headers.get('CST');
      const securityToken = res.headers.get('x-security-token') || res.headers.get('X-SECURITY-TOKEN');
      console.log('AUTH SUCCESS');
      console.log('Response body:');
      console.log(JSON.stringify(body, null, 2));
      console.log('Session headers present:', {
        cst: !!cst,
        securityToken: !!securityToken,
      });
    } else {
      console.log('AUTH FAILURE');
      console.log(`HTTP ${res.status}`);
      console.log('Response body:');
      console.log(JSON.stringify(body, null, 2));
    }
  } catch (err) {
    console.log('AUTH ERROR');
    console.log(err.message);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
