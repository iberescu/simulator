'use strict';
const fs = require('fs');
const path = require('path');
const log = require('../logger').child({ mod: 'useragents' });
/*
 * Chromium-family user agents only — we drive real Chromium, so a Safari/Firefox UA would be an
 * easy tell. The Chrome version always tracks the REAL engine version (so the UA, navigator
 * fingerprint and Client Hints all agree); only the OS/device varies between sessions.
 *
 * Operators edit config/useragents.json (array of UA strings). Use the literal {CHROME} token where
 * the Chrome version goes — it is replaced with the running engine version at pick time. An empty
 * list falls back to the built-ins below. Each pick also carries Client-Hint metadata (uaMetadata)
 * applied via CDP so sec-ch-ua matches the UA string.
 */
const DESKTOP = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME} Safari/537.36', viewport: { width: 1920, height: 1080 }, dpr: 1, platform: 'Windows' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME} Safari/537.36', viewport: { width: 1536, height: 864 }, dpr: 1.25, platform: 'Windows' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME} Safari/537.36', viewport: { width: 1680, height: 1050 }, dpr: 2, platform: 'macOS' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME} Safari/537.36', viewport: { width: 1920, height: 1080 }, dpr: 1, platform: 'Linux' },
];

const MOBILE = [
  { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME} Mobile Safari/537.36', viewport: { width: 412, height: 915 }, dpr: 2.625, platform: 'Android', mobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME} Mobile Safari/537.36', viewport: { width: 360, height: 800 }, dpr: 3, platform: 'Android', mobile: true },
];

const US_TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix',
];

const DEFAULT_ENGINE = '131.0.6778.33'; // matches the pinned Playwright image; corrected at runtime

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// Real engine version (set once the browser launches); falls back to env / pinned default.
function engineFull() {
  let v = null;
  try { v = require('./browser').engineVersion(); } catch { /* browser not ready */ }
  return v || process.env.CHROME_VERSION || DEFAULT_ENGINE;
}
function applyChromeToken(ua, full) {
  const major = String(full).split('.')[0];
  return ua.replace(/\{CHROME\}/g, `${major}.0.0.0`);
}

function isMobileUA(ua) {
  return /\bMobile\b/i.test(ua) || /iPhone|iPod|Android.*Mobile/i.test(ua);
}
function platformFromUA(ua) {
  // Order matters: iOS UAs contain "Mac OS X" and Android UAs contain "Linux".
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Windows';
}
function chromeMajorFromUA(ua) { const m = ua.match(/Chrome\/(\d+)/); return m ? m[1] : null; }

function platformVersion(ua, platform) {
  if (platform === 'Android') { const m = ua.match(/Android (\d+)/); return `${m ? m[1] : '14'}.0.0`; }
  if (platform === 'iOS') { const m = ua.match(/OS (\d+)[_.](\d+)/); return m ? `${m[1]}.${m[2]}.0` : '18.0.0'; }
  if (platform === 'Windows') return '15.0.0';
  if (platform === 'macOS') return '14.5.0';
  return '';
}
function deviceModel(ua, mobile) {
  if (!mobile) return '';
  const m = ua.match(/Android \d+; ([^);]+?)\)/);
  if (m) return m[1].trim();
  if (/iPhone/.test(ua)) return 'iPhone';
  return '';
}
function brands(major, isEdge) {
  const out = [{ brand: 'Chromium', version: String(major) }];
  out.push(isEdge ? { brand: 'Microsoft Edge', version: String(major) } : { brand: 'Google Chrome', version: String(major) });
  out.push({ brand: 'Not_A Brand', version: '24' });
  return out;
}
// Client-Hint metadata coherent with the UA string (same Chrome major, OS, mobile flag).
function metadataFor(ua, engineFullVer) {
  const uaMajor = chromeMajorFromUA(ua) || String(engineFullVer).split('.')[0];
  const full = String(engineFullVer).split('.')[0] === uaMajor ? engineFullVer : `${uaMajor}.0.0.0`;
  const mobile = isMobileUA(ua);
  const platform = platformFromUA(ua);
  const isEdge = /Edg\//.test(ua);
  const b = brands(uaMajor, isEdge);
  return {
    brands: b,
    fullVersionList: b.map((x) => ({ brand: x.brand, version: /Brand/i.test(x.brand) ? x.version : full })),
    fullVersion: full,
    platform,
    platformVersion: platformVersion(ua, platform),
    architecture: mobile ? '' : 'x86',
    bitness: mobile ? '' : '64',
    model: deviceModel(ua, mobile),
    mobile,
    wow64: false,
  };
}

// --- Optional operator-supplied user-agent list (config/useragents.json) ---
function loadCustomUserAgents() {
  const file = process.env.USER_AGENTS_FILE
    || path.join(__dirname, '..', '..', 'config', 'useragents.json');
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const arr = Array.isArray(json) ? json : (json.userAgents || json.user_agents || []);
    const cleaned = arr.map((s) => String(s).trim()).filter(Boolean);
    if (cleaned.length) log.info('using custom user-agent list', { count: cleaned.length, file });
    return cleaned;
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('could not read user-agent list; using built-ins', { err: e.message });
    return [];
  }
}
const CUSTOM = loadCustomUserAgents();

// Build a coherent fingerprint from a resolved UA string: device class from the UA, a realistic
// viewport/dpr from the matching built-in pool, and Client-Hint metadata.
function fingerprintFromUA(ua, full) {
  const mobile = isMobileUA(ua);
  const base = pick(mobile ? MOBILE : DESKTOP);
  return {
    device: mobile ? 'mobile' : 'desktop',
    userAgent: ua,
    viewport: base.viewport,
    deviceScaleFactor: base.dpr,
    isMobile: mobile,
    hasTouch: mobile,
    platform: platformFromUA(ua),
    locale: 'en-US',
    timezoneId: pick(US_TIMEZONES),
    uaMetadata: metadataFor(ua, full),
  };
}

// device: 'desktop' | 'mobile' | undefined (weighted default ~62% desktop)
function pickUserAgent(device) {
  const full = engineFull();
  const pool = (CUSTOM.length ? CUSTOM : [...DESKTOP, ...MOBILE].map((e) => e.ua))
    .map((ua) => applyChromeToken(ua, full));

  let candidates = pool;
  if (device === 'mobile' || device === 'desktop') {
    const filtered = pool.filter((ua) => isMobileUA(ua) === (device === 'mobile'));
    if (filtered.length) candidates = filtered;
  } else if (Math.random() >= 0.62) {
    const m = pool.filter(isMobileUA);
    if (m.length) candidates = m;
  } else {
    const d = pool.filter((ua) => !isMobileUA(ua));
    if (d.length) candidates = d;
  }
  return fingerprintFromUA(pick(candidates), full);
}

module.exports = { pickUserAgent, DESKTOP, MOBILE };
