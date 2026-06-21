'use strict';
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const log = require('../logger').child({ mod: 'runner' });
const { newVisitContext, applyUaOverride } = require('./browser');
const { pickUserAgent } = require('./useragents');
const { proxyRotator } = require('../proxy/rotator');
const forwarder = require('../proxy/forwarder');
const { buildIdentity } = require('../data/personas');
const emailMod = require('../identity/email');
const behaviors = require('./behaviors');

const shortId = () => crypto.randomBytes(8).toString('hex');

// A "conversion" = a converting visit that completed a terminal high-intent action.
function detectConversion(actions) {
  let type = null;
  for (const a of (actions || [])) {
    if (!a.ok) continue;
    if (a.action === 'checkout') type = 'checkout';
    else if ((a.action === 'fill_form' || a.action === 'price_inquiry') && /submitted/.test(a.detail || '')) {
      type = type || (a.action === 'price_inquiry' ? 'price_inquiry' : 'form_submit');
    } else if (a.action === 'add_to_cart' && !type) type = 'add_to_cart';
  }
  const hard = !!type && type !== 'add_to_cart';
  return { conversion: hard, conversionType: type };
}

function appendQuery(urlStr, params) {
  try {
    const u = new URL(urlStr);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    return u.href;
  } catch { return urlStr; }
}

// Referer is tagged as coming from leadmaker.ai with a unique per-visit id (cid) so the customer
// can always identify and filter this traffic in their analytics.
function buildReferer(cid) {
  return `${config.sim.refererBase}/?cid=${cid}&src=ad-campaign`;
}

function resolveEntry(site, strategy, links) {
  const e = (strategy.entry || 'homepage').trim();
  if (!e || /^homepage$/i.test(e)) return site.url;
  try {
    const u = new URL(e, site.url);
    const base = new URL(site.url);
    if (u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')) return u.href;
  } catch { /* ignore */ }
  const hit = (links || []).find((l) => l.includes(e));
  return hit || site.url;
}

// Enter the target the way a real ad click does: load the referrer page, then click a link to the
// landing URL. This makes Referer + Sec-Fetch-Site (cross-site) + Sec-Fetch-User (?1) mutually
// consistent — unlike goto({referer}), which sends a Referer but Sec-Fetch-Site: none (a bot tell).
// Falls back to a direct navigation if the referrer page can't be loaded.
async function enterSite(page, referer, entryUrl) {
  const t = config.sim.navTimeoutMs;
  const targetHost = new URL(entryUrl).host;
  // Optional realistic ad-click: load the referrer page and click through, so Referer +
  // Sec-Fetch-Site (cross-site) + Sec-Fetch-User (?1) are coherent. Enabled only when the referrer
  // actually serves (REFERRER_CLICK=true), since loading a dead referrer would break entry.
  if (config.sim.referrerClick && referer) {
    try {
      const resp = await page.goto(referer, { waitUntil: 'domcontentloaded', timeout: Math.min(t, 20000) });
      if (resp && resp.status() < 400) {
        await page.evaluate((u) => {
          const a = document.createElement('a');
          a.id = '__entry';
          a.href = u;
          a.referrerPolicy = 'unsafe-url'; // keep the full campaign referer URL (cid/src)
          a.textContent = 'Continue';
          a.style.cssText = 'position:fixed;left:8px;top:8px;z-index:2147483647';
          document.body.appendChild(a);
        }, entryUrl);
        await Promise.all([
          page.waitForURL((u) => { try { return new URL(u).host === targetHost; } catch { return false; } }, { timeout: t }),
          page.click('#__entry', { timeout: 8000 }), // trusted gesture -> Sec-Fetch-User: ?1
        ]);
        if (new URL(page.url()).host === targetHost) return;
      }
    } catch { /* fall through to clean direct entry */ }
  }
  // Clean direct entry: no forged Referer, so Sec-Fetch-Site: none stays coherent (a referrer-
  // stripped paid click / direct visit). Attribution rides on the utm_source + cid query params.
  // Retry once if a prior failed navigation left the page mid-flight.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: t }); return; }
    catch (e) { if (attempt === 1 || !/interrupted by another navigation/i.test(e.message)) throw e; }
  }
}

async function runVisit({ site, strategy, links, runId }) {
  const cid = shortId();
  const fp = pickUserAgent(strategy.device);
  if (site.timezone) fp.timezoneId = site.timezone; // emulate a visitor in the site's local timezone
  // One sticky residential IP per visit (seeded by cid); a fresh IP for the next session.
  const proxy = proxyRotator.get({ session: cid });
  // Each session lasts a random 2-3 min so it maps 1:1 to one sticky proxy IP.
  const { sessionMinMs, sessionMaxMs } = config.sim;
  const sessionTargetMs = sessionMinMs + Math.floor(Math.random() * (Math.max(sessionMinMs, sessionMaxMs) - sessionMinMs + 1));
  const identity = buildIdentity();
  const ev = await emailMod.generateVerified(identity);
  identity.email = ev.email;
  const referer = buildReferer(cid);

  let entryUrl = resolveEntry(site, strategy, links);
  if (config.sim.appendUtm) {
    entryUrl = appendQuery(entryUrl, {
      utm_source: config.sim.utmSource, utm_medium: 'campaign', utm_campaign: 'golive', cid,
    });
  }

  const vlog = log.child({ cid, site: site.id });
  const visit = db.createVisit({
    runId, siteId: site.id, cid, converting: strategy.converting,
    persona: strategy.persona,
    identityEmail: identity.email,
    userAgent: fp.userAgent, device: fp.device,
    proxyLabel: proxy ? proxy.label : 'direct',
    referer, entryUrl,
  });

  const startedAt = Date.now();
  let ctx = null;
  let fwd = null;
  try {
    // Chromium drops the proxy username params, so route via a local forwarder that injects the
    // full Oxylabs username (cc-US + sticky sessid) upstream. Falls back to the raw proxy if needed.
    let ctxProxy = proxy;
    if (proxy && proxy.username) {
      fwd = await forwarder.open(proxy);
      if (fwd) ctxProxy = { server: fwd };
    }
    ctx = await newVisitContext(fp, ctxProxy);
    const page = await ctx.newPage();
    await applyUaOverride(page, fp); // coherent UA + client hints before any navigation
    await enterSite(page, referer, entryUrl);
    const res = await behaviors.executeStrategy(page, { site, strategy, links, identity, cid, vlog, sessionTargetMs });
    const conv = detectConversion(res.actions);
    db.finishVisit(visit.id, {
      durationMs: Date.now() - startedAt,
      pagesVisited: res.pagesVisited,
      actions: res.actions,
      status: 'completed',
      conversion: conv.conversion,
      conversionType: conv.conversionType,
      emailVerified: ev.verified,
    });
    vlog.info('visit completed', {
      converting: strategy.converting, device: fp.device,
      pages: res.pagesVisited, proxy: proxy ? proxy.label : 'direct',
    });
    return { ok: true, cid, visitId: visit.id, pagesVisited: res.pagesVisited };
  } catch (e) {
    db.finishVisit(visit.id, { durationMs: Date.now() - startedAt, status: 'failed', error: e.message, emailVerified: ev.verified });
    vlog.warn('visit failed', { err: e.message });
    return { ok: false, cid, visitId: visit.id, error: e.message };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (fwd) await forwarder.close(fwd);
  }
}

module.exports = { runVisit, buildReferer, appendQuery, resolveEntry };
