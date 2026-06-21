'use strict';
// Self-contained credential + API-shape check. No external deps (uses global fetch).
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((/^".*"$/.test(v)) || (/^'.*'$/.test(v))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv();

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
const CF_TOKEN = process.env.CF_API_TOKEN;
const GEMINI = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const DO = process.env.DIGITALOCEAN_TOKEN;

async function show(label, fn) {
  try {
    const r = await fn();
    const s = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
    console.log(`\n===== [${label}] OK =====\n${s.slice(0, 2000)}`);
    return r;
  } catch (e) {
    console.log(`\n===== [${label}] ERROR =====\n${e.message}`);
    return null;
  }
}

async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

(async () => {
  await show('CF token verify', () => getJson('https://api.cloudflare.com/client/v4/user/tokens/verify', {
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  }));

  await show('CF zones (layout.ai)', () => getJson('https://api.cloudflare.com/client/v4/zones?name=layout.ai', {
    headers: { Authorization: `Bearer ${CF_TOKEN}` },
  }));

  await show('CF browser-rendering /links example.com', () => getJson(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/browser-rendering/links`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    },
  ));

  await show('Gemini generateContent', () => getJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }] }),
    },
  ));

  await show('DO account', () => getJson('https://api.digitalocean.com/v2/account', {
    headers: { Authorization: `Bearer ${DO}` },
  }));
})();
