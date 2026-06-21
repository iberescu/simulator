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
      utm_source: 'leadmaker.ai', utm_medium: 'campaign', utm_campaign: 'golive', cid,
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
    await page.goto(entryUrl, { referer, waitUntil: 'domcontentloaded' });
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
