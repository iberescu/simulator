'use strict';
const config = require('../config');
const log = require('../logger').child({ mod: 'browser' });

let chromium;
try {
  const pe = require('playwright-extra');
  chromium = pe.chromium;
  try {
    const stealth = require('puppeteer-extra-plugin-stealth')();
    chromium.use(stealth);
    log.info('stealth plugin enabled');
  } catch (e) {
    log.warn('stealth plugin unavailable; continuing without it', { err: e.message });
  }
} catch (e) {
  chromium = require('playwright').chromium;
  log.warn('playwright-extra unavailable; using plain playwright', { err: e.message });
}

let _browser = null;
let _launching = null;

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
    b.on('disconnected', () => { _browser = null; });
    log.info('browser launched', { headless: config.sim.headless });
    return b;
  }).catch((e) => { _launching = null; throw e; });
  return _launching;
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

module.exports = { getBrowser, newVisitContext, closeBrowser };
