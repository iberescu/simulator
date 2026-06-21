'use strict';
const fs = require('fs');
const path = require('path');
const log = require('../logger').child({ mod: 'useragents' });
/*
 * Chromium-family user agents only. We drive real Chromium, so advertising a Chrome/Edge UA keeps
 * the navigator fingerprint internally consistent (a Safari/Firefox UA on Chromium is an easy tell).
 * Each entry carries a matching viewport + device metadata so the whole fingerprint is coherent.
 *
 * Operators can override the pool via config/useragents.json (an array of UA strings); one is
 * chosen at random per session and given a coherent viewport/platform derived from the string.
 * An empty/missing list falls back to the curated built-ins below.
 */
const DESKTOP = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', viewport: { width: 1920, height: 1080 }, dpr: 1, platform: 'Windows' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', viewport: { width: 1536, height: 864 }, dpr: 1.25, platform: 'Windows' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0', viewport: { width: 1366, height: 768 }, dpr: 1, platform: 'Windows' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', viewport: { width: 1680, height: 1050 }, dpr: 2, platform: 'macOS' },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', viewport: { width: 1440, height: 900 }, dpr: 2, platform: 'macOS' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', viewport: { width: 1920, height: 1080 }, dpr: 1, platform: 'Linux' },
];

const MOBILE = [
  { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', viewport: { width: 412, height: 915 }, dpr: 2.625, platform: 'Android', mobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', viewport: { width: 360, height: 800 }, dpr: 3, platform: 'Android', mobile: true },
  { ua: 'Mozilla/5.0 (Linux; Android 13; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', viewport: { width: 384, height: 854 }, dpr: 2.75, platform: 'Android', mobile: true },
];

const US_TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

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

function isMobileUA(ua) {
  return /\bMobile\b/i.test(ua) || /iPhone|iPod|Android.*Mobile/i.test(ua);
}
function platformFromUA(ua) {
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Windows';
}
// Build a coherent fingerprint from a raw UA string: device class is read from the UA itself, and a
// realistic viewport/dpr is drawn from the matching built-in pool so the whole fingerprint stays consistent.
function fingerprintFromUA(ua) {
  const mobile = isMobileUA(ua);
  const base = mobile ? pick(MOBILE) : pick(DESKTOP);
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
  };
}

// device: 'desktop' | 'mobile' | undefined (weighted default ~62% desktop)
function pickUserAgent(device) {
  // Operator-supplied list wins. Honor an explicit device request by filtering; if none match
  // (e.g. a desktop-only list asked for mobile), use the full list and derive device from the UA.
  if (CUSTOM.length) {
    let pool = CUSTOM;
    if (device === 'mobile' || device === 'desktop') {
      const filtered = CUSTOM.filter((ua) => isMobileUA(ua) === (device === 'mobile'));
      if (filtered.length) pool = filtered;
    }
    return fingerprintFromUA(pick(pool));
  }

  let d = device;
  if (d !== 'desktop' && d !== 'mobile') d = Math.random() < 0.62 ? 'desktop' : 'mobile';
  const base = d === 'mobile' ? pick(MOBILE) : pick(DESKTOP);
  return {
    device: d,
    userAgent: base.ua,
    viewport: base.viewport,
    deviceScaleFactor: base.dpr,
    isMobile: !!base.mobile,
    hasTouch: !!base.mobile,
    platform: base.platform,
    locale: 'en-US',
    timezoneId: pick(US_TIMEZONES),
  };
}

module.exports = { pickUserAgent, DESKTOP, MOBILE };
