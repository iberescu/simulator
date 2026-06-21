'use strict';
const express = require('express');
const config = require('../config');
const db = require('../db');
const log = require('../logger').child({ mod: 'api' });
const scheduler = require('../scheduler/cron');
const monitor = require('./monitor');
const probe = require('./probe');

function validateTargetUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, error: 'invalid URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'URL must be http(s)' };
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, error: 'localhost not allowed' };
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return { ok: false, error: 'private/loopback IP not allowed' };
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return { ok: false, error: 'private IP not allowed' };
  if (host === '::1' || host === '[::1]') return { ok: false, error: 'loopback not allowed' };
  if (host === '169.254.169.254') return { ok: false, error: 'metadata IP not allowed' };
  return { ok: true, url: u.href };
}

function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function getBearer(req) {
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : (req.get('x-api-key') || '');
}

function requireApiKey(req, res, next) {
  if (!config.apiKey) return next(); // auth disabled (dev)
  if (getBearer(req) === config.apiKey) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Status access: global API key OR the per-campaign token.
function requireCampaignAccess(req, res, next) {
  const site = db.getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'campaign not found' });
  req.site = site;
  if (!config.apiKey) return next();
  const bearer = getBearer(req);
  const token = req.get('x-site-token') || req.query.token || '';
  if (bearer === config.apiKey || token === site.site_token) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function campaignSummary(site) {
  const counts = db.countVisits(site.id) || {};
  const strat = db.getLatestStrategies(site.id);
  return {
    id: site.id,
    url: site.url,
    status: site.status,
    timezone: site.timezone,
    customer: { name: site.customer_name, email: site.customer_email, company: site.customer_company },
    daily_visits: site.daily_visits,
    created_at: site.created_at,
    stopped_at: site.stopped_at,
    visits_total: counts.n || 0,
    visits_completed: counts.ok || 0,
    visits_converting: counts.c || 0,
    strategies: strat ? { source: strat.source, count: (() => { try { return JSON.parse(strat.data).length; } catch { return 0; } })(), ecommerce: !!strat.is_ecommerce, updated_at: strat.created_at } : null,
  };
}

function visitView(v) {
  let actions = [];
  try { actions = JSON.parse(v.actions); } catch { /* ignore */ }
  return {
    cid: v.cid,
    converting: !!v.converting,
    conversion: !!v.conversion,
    conversion_type: v.conversion_type,
    status: v.status,
    device: v.device,
    referer: v.referer,
    entry_url: v.entry_url,
    pages_visited: v.pages_visited,
    duration_ms: v.duration_ms,
    started_at: v.started_at,
    finished_at: v.finished_at,
    actions,
    error: v.error,
  };
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.on('finish', () => log.info('req', { m: req.method, p: req.path, s: res.statusCode }));
    next();
  });

  monitor.mount(app); // token-gated /__monitor live dashboard (no-op unless MONITOR_TOKEN set)
  probe.mount(app);   // /__probe controlled test target (records exit IP + UA per hit)

  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  app.get('/', (req, res) => res.json({
    service: 'ad-campaigns',
    description: 'Generates automated ad-campaign-style visits to a website you own or are authorized to test, so you can validate analytics and conversion tracking BEFORE launching real paid campaigns. Every visit is tagged (utm_source=leadmaker.ai + a unique cid) so you can filter it from your reports. No real purchases or payments are made.',
    integration: 'Two calls: (1) submit a URL to the entry point, (2) poll the status endpoint. Nothing else is required.',
    endpoints: {
      'POST /api/campaigns': 'ENTRY — submit { url, customer:{name,email,company}, timezone?, daily_visits?, notes? }; starts the campaign and returns id + token.',
      'GET /api/campaigns/:id/status': 'STATUS — latest history (totals, conversions, pages, funnel, per-day, recent visits).',
    },
    auth: config.apiKey ? 'Bearer <API_KEY> on the entry call; the per-campaign token (?token=) reads its own status.' : 'OPEN (no API_KEY set)',
  }));

  // ---- ENTRY: submit a URL to start an ad-campaign traffic run ----
  app.post('/api/campaigns', requireApiKey, (req, res) => {
    const body = req.body || {};
    const v = validateTargetUrl(body.url);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const customer = body.customer || {};
    const tzInput = body.timezone || customer.timezone;
    const tzValid = validTimezone(tzInput);
    const timezone = tzValid ? tzInput : config.defaultTimezone;
    const site = db.createSite({
      url: v.url,
      customer_name: body.customer_name || customer.name,
      customer_email: body.customer_email || customer.email,
      customer_company: body.customer_company || customer.company,
      notes: body.notes,
      timezone,
      daily_visits: Number.isInteger(body.daily_visits) ? body.daily_visits : undefined,
      converting_visits: Number.isInteger(body.converting_visits) ? body.converting_visits : undefined,
    });
    scheduler.primeSite(site);
    log.info('campaign created', { id: site.id, url: site.url, timezone });
    res.status(201).json({
      id: site.id,
      url: site.url,
      status: site.status,
      timezone,
      timezone_note: !tzInput
        ? `No timezone provided; defaulted to ${timezone}. Pass "timezone" (IANA, e.g. "Europe/Bucharest") so visits match your audience's local active hours.`
        : (!tzValid ? `Invalid timezone "${tzInput}"; defaulted to ${timezone}.` : undefined),
      token: site.site_token,
      daily_visits: site.daily_visits,
      note: "Campaign started. Automated ad-campaign visits run hourly within your audience's local active hours. Poll status_url for results.",
      status_url: `/api/campaigns/${site.id}/status?token=${site.site_token}`,
    });
  });

  // ---- STATUS: latest history for a campaign ----
  app.get('/api/campaigns/:id/status', requireCampaignAccess, (req, res) => {
    const site = req.site;
    const stats = db.siteStats(site.id);
    const daily = db.siteDaily(site.id, 14);
    const byType = db.conversionsByType(site.id);
    const byDevice = db.deviceBreakdown(site.id);

    const recent = db.listVisits(site.id, 500);
    const actions = {};
    for (const v of recent) {
      let acts = [];
      try { acts = JSON.parse(v.actions); } catch { /* ignore */ }
      for (const a of acts) {
        actions[a.action] = actions[a.action] || { attempts: 0, ok: 0 };
        actions[a.action].attempts += 1;
        if (a.ok) actions[a.action].ok += 1;
      }
    }

    res.json({
      campaign: campaignSummary(site),
      history: {
        totals: {
          visits: stats.visits || 0,
          completed: stats.completed || 0,
          failed: stats.failed || 0,
          conversions: stats.conversions || 0,
          pages_hit: stats.pages_hit || 0,
          first_visit_at: stats.first_visit_at || null,
          last_visit_at: stats.last_visit_at || null,
        },
        conversions_by_type: byType,
        by_device: byDevice,
        actions,
        daily,
      },
    });
  });

  // ---- Operator-only lifecycle controls (NOT part of the 3rd-party surface; global API key only) ----
  app.post('/api/campaigns/:id/stop', requireApiKey, (req, res) => {
    const site = db.getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'campaign not found' });
    db.setSiteStatus(site.id, 'stopped');
    log.info('campaign stopped', { id: site.id });
    res.json({ id: site.id, status: 'stopped' });
  });

  app.post('/api/campaigns/:id/start', requireApiKey, (req, res) => {
    const site = db.getSite(req.params.id);
    if (!site) return res.status(404).json({ error: 'campaign not found' });
    db.setSiteStatus(site.id, 'active');
    scheduler.primeSite(db.getSite(site.id));
    res.json({ id: site.id, status: 'active' });
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error('api error', { err: err.message });
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp, validateTargetUrl, visitView };
