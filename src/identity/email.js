'use strict';
const dns = require('dns').promises;
const config = require('../config');
const log = require('../logger').child({ mod: 'email' });

const mxCache = new Map();      // domain -> { ok, ts }
const verifyCache = new Map();  // address -> { valid, reason }

const clean = (s) => String(s || '').normalize('NFKD').replace(/[^a-zA-Z0-9]/g, '');
const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function localPart(p) {
  const f = clean(p.first || p.firstName).toLowerCase();
  const l = clean(p.last || p.lastName).toLowerCase();
  const fi = f.slice(0, 1);
  const n = randInt(2, 98);
  return pick([
    `${f}.${l}`, `${f}${l}`, `${fi}${l}`, `${f}.${l}${n}`,
    `${f}${l}${n}`, `${f}.${l}.${n}`, `${f}_${l}`, `${fi}.${l}${n}`,
  ]);
}

// Build a candidate address according to EMAIL_MODE.
function generate(p) {
  const lp = localPart(p);
  if (config.email.mode === 'gmail-alias' && config.email.gmailBase) {
    const [base, dom = 'gmail.com'] = config.email.gmailBase.split('@');
    return `${base}+${lp}@${dom}`.toLowerCase();
  }
  if (config.email.mode === 'gmail') return `${lp}@gmail.com`.toLowerCase();
  return `${lp}@${pick(config.email.domains)}`.toLowerCase();
}

async function mxOk(domain) {
  const c = mxCache.get(domain);
  if (c && Date.now() - c.ts < 6 * 3600 * 1000) return c.ok;
  let ok = false;
  try { const recs = await dns.resolveMx(domain); ok = Array.isArray(recs) && recs.length > 0; } catch { ok = false; }
  mxCache.set(domain, { ok, ts: Date.now() });
  return ok;
}

// Verify an address "exists"/is deliverable. Keyless default = DNS MX check on the domain.
// Optional paid providers (set EMAIL_VERIFY + EMAIL_VERIFY_API_KEY) do per-address checks.
async function verify(address) {
  if (verifyCache.has(address)) return verifyCache.get(address);
  const provider = config.email.verify;
  let result = { valid: true, reason: 'none' };
  try {
    if (provider === 'none') {
      result = { valid: true, reason: 'none' };
    } else if (provider === 'abstract' && config.email.verifyApiKey) {
      const r = await fetch(`https://emailvalidation.abstractapi.com/v1/?api_key=${config.email.verifyApiKey}&email=${encodeURIComponent(address)}`);
      const j = await r.json();
      const d = String(j.deliverability || '').toUpperCase();
      result = { valid: d === 'DELIVERABLE' || d === 'UNKNOWN', reason: `abstract:${d || '?'}` };
    } else if (provider === 'zerobounce' && config.email.verifyApiKey) {
      const r = await fetch(`https://api.zerobounce.net/v2/validate?api_key=${config.email.verifyApiKey}&email=${encodeURIComponent(address)}`);
      const j = await r.json();
      const s = String(j.status || '').toLowerCase();
      result = { valid: ['valid', 'catch-all', 'unknown'].includes(s), reason: `zerobounce:${s || '?'}` };
    } else {
      const domain = address.split('@')[1];
      const ok = await mxOk(domain);
      result = { valid: ok, reason: `mx:${ok ? 'ok' : 'no-mx'}` };
    }
  } catch (e) {
    result = { valid: true, reason: `verify-error:${e.message}` }; // fail-open: don't block a visit on a verifier hiccup
  }
  verifyCache.set(address, result);
  return result;
}

// Generate + verify, retrying a few candidates until one passes.
async function generateVerified(p) {
  for (let i = 0; i < 4; i++) {
    const addr = generate(p);
    const v = await verify(addr);
    if (v.valid) return { email: addr, verified: true, reason: v.reason };
  }
  const addr = generate(p);
  return { email: addr, verified: false, reason: 'unverified-fallback' };
}

module.exports = { generate, verify, generateVerified, mxOk };
