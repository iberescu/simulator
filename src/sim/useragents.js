'use strict';
/*
 * Chromium-family user agents only. We drive real Chromium, so advertising a Chrome/Edge UA keeps
 * the navigator fingerprint internally consistent (a Safari/Firefox UA on Chromium is an easy tell).
 * Each entry carries a matching viewport + device metadata so the whole fingerprint is coherent.
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

// device: 'desktop' | 'mobile' | undefined (weighted default ~62% desktop)
function pickUserAgent(device) {
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
