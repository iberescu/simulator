'use strict';
const config = require('../config');
const log = require('../logger').child({ mod: 'browser' });

let chromium;
try {
  const pe = require('playwright-extra');
  chromium = pe.chromium;
  try {
    const stealth = require('puppeteer-extra-plugin-stealth')();
    // We set a coherent per-session UA + client hints ourselves (see applyUaOverride). The
    // stealth UA evasion would otherwise force every visit to the real engine UA, killing rotation.
    stealth.enabledEvasions.delete('user-agent-override');
    chromium.use(stealth);
    log.info('stealth plugin enabled (ua-override evasion disabled)');
  } catch (e) {
    log.warn('stealth plugin unavailable; continuing without it', { err: e.message });
  }
} catch (e) {
  chromium = require('playwright').chromium;
  log.warn('playwright-extra unavailable; using plain playwright', { err: e.message });
}

let _browser = null;
let _launching = null;
let _engineVersion = null; // real Chromium full version, e.g. "131.0.6778.33"

function engineVersion() { return _engineVersion; }

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launching) return _launching;
  _launching = chromium.launch({
    headless: config.sim.headless,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--disable-gpu',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    ],
  }).then((b) => {
    _browser = b;
    _launching = null;
    try { _engineVersion = b.version(); } catch { /* keep null */ }
    b.on('disconnected', () => { _browser = null; });
    log.info('browser launched', { headless: config.sim.headless, engine: _engineVersion });
    return b;
  }).catch((e) => { _launching = null; throw e; });
  return _launching;
}

// Apply a coherent UA + Client Hints override (CDP) so the HTTP UA, navigator.userAgentData and
// sec-ch-* headers all agree. fp.uaMetadata carries the brands/platform; the Chrome version tracks
// the real engine, so only the OS/device varies between sessions.
async function applyUaOverride(page, fp) {
  if (!fp || !fp.uaMetadata) return;
  try {
    const client = await page.context().newCDPSession(page);
    await client.send('Emulation.setUserAgentOverride', {
      userAgent: fp.userAgent,
      acceptLanguage: `${fp.locale},en;q=0.9`,
      platform: fp.uaMetadata.platform,
      userAgentMetadata: fp.uaMetadata,
    });
  } catch (e) {
    log.warn('ua override failed; visit continues with context UA', { err: e.message });
  }
}

async function newVisitContext(fp, proxy) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: fp.userAgent,
    viewport: fp.viewport,
    deviceScaleFactor: fp.deviceScaleFactor,
    isMobile: fp.isMobile,
    hasTouch: fp.hasTouch,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    proxy: proxy ? { server: proxy.server, username: proxy.username, password: proxy.password } : undefined,
    extraHTTPHeaders: { 'Accept-Language': `${fp.locale},en;q=0.9` },
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
  });
  ctx.setDefaultNavigationTimeout(config.sim.navTimeoutMs);
  ctx.setDefaultTimeout(15000);
  return ctx;
}

async function closeBrowser() {
  if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
}

module.exports = { getBrowser, newVisitContext, closeBrowser, applyUaOverride, engineVersion };
