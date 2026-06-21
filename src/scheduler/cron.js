'use strict';
const cron = require('node-cron');
const config = require('../config');
const db = require('../db');
const log = require('../logger').child({ mod: 'scheduler' });
const { crawlSite } = require('../crawl/cloudflare');
const { generateStrategies } = require('../ai/gemini');
const { runVisit } = require('../sim/runner');

// Local-hour weights (index = hour 0..23 in the SITE's timezone). Zero outside the active window
// so no visits happen overnight; concentrated across the ~8-12 hours people are actually online.
const HOURLY_WEIGHTS = [0, 0, 0, 0, 0, 0, 0, 2, 5, 8, 9, 9, 8, 7, 7, 8, 9, 10, 9, 7, 5, 3, 1, 0];

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function weightedHour() {
  const total = HOURLY_WEIGHTS.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let h = 0; h < 24; h++) { r -= HOURLY_WEIGHTS[h]; if (r <= 0) return h; }
  return 23;
}

function nowParts(tz = config.timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { hour: get('hour') % 24, minute: get('minute') };
}

// ---- concurrency limiter ----
class Limiter {
  constructor(n) { this.n = Math.max(1, n); this.active = 0; this.q = []; }
  run(fn) {
    return new Promise((resolve, reject) => {
      const go = () => {
        this.active++;
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
          this.active--;
          const next = this.q.shift();
          if (next) next();
        });
      };
      if (this.active < this.n) go(); else this.q.push(go);
    });
  }
}
const limiter = new Limiter(config.sim.maxConcurrentVisits);

// ---- plan ----
function buildPlan(site) {
  const total = site.daily_visits || config.sim.dailyVisits;
  const cv = site.converting_visits || config.sim.convertingVisits;
  const convertTarget = Math.min(total, randInt(Math.max(1, cv - 1), cv)); // 4-5 by default
  const slots = [];
  for (let i = 0; i < total; i++) slots.push({ hour: weightedHour(), minute: randInt(0, 59), converting: false, done: false });
  shuffle([...Array(total).keys()]).slice(0, convertTarget).forEach((i) => { slots[i].converting = true; });
  slots.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  return slots;
}

function getOrBuildPlan(site, day) {
  const existing = db.getPlan(site.id, day);
  if (existing) { try { return JSON.parse(existing.data); } catch { /* rebuild */ } }
  const plan = buildPlan(site);
  db.savePlan(site.id, day, plan);
  log.info('daily plan built', { site: site.id, day, total: plan.length, converting: plan.filter((s) => s.converting).length });
  return plan;
}

// ---- data (crawl + strategies), cached with TTL ----
async function ensureData(site, { force = false } = {}) {
  const latest = db.getLatestStrategies(site.id);
  const ttlMs = config.sim.strategyTtlHours * 3600 * 1000;
  let strategies = null;
  if (latest && !force) {
    try { strategies = JSON.parse(latest.data); } catch { strategies = null; }
    const ageOk = Date.now() - Date.parse(latest.created_at) < ttlMs;
    if (strategies && strategies.length && ageOk) {
      const crawl = db.getLatestCrawl(site.id);
      let links = [site.url];
      try { if (crawl) links = JSON.parse(crawl.links); } catch { /* keep default */ }
      return { strategies, links };
    }
  }
  // (re)build
  const crawl = await crawlSite(site.url);
  const crawlRow = db.saveCrawl(site.id, crawl);
  const strat = await generateStrategies(site, crawl);
  db.saveStrategies(site.id, { data: strat.data, source: strat.source, isEcommerce: strat.isEcommerce, crawlId: crawlRow.id, error: strat.error });
  log.info('strategies refreshed', { site: site.id, source: strat.source, count: strat.data.length, ecommerce: strat.isEcommerce });
  return { strategies: strat.data, links: crawl.links };
}

function pickStrategy(strategies, converting) {
  const pool = strategies.filter((s) => !!s.converting === !!converting);
  const use = pool.length ? pool : strategies;
  return use[randInt(0, use.length - 1)];
}

// ---- hourly execution ----
const scheduledKeys = new Set();

async function runSiteHour(site, { catchUp = false } = {}) {
  let data;
  try { data = await ensureData(site); } catch (e) { log.error('ensureData failed', { site: site.id, err: e.message }); return; }
  const { strategies, links } = data;
  if (!strategies || !strategies.length) { log.warn('no strategies; skipping', { site: site.id }); return; }

  const tz = site.timezone || config.defaultTimezone;
  const day = db.dayKey(new Date(), tz);
  const plan = getOrBuildPlan(site, day);
  const { hour: curHour, minute: curMin } = nowParts(tz);

  const due = [];
  plan.forEach((slot, index) => { if (slot.hour === curHour && !slot.done) due.push({ slot, index }); });
  if (!due.length) return;

  const run = db.createRun(site.id, { hour: curHour, planned: due.length, kind: catchUp ? 'startup' : 'scheduled' });
  const counters = { done: 0, ok: 0, fail: 0, total: due.length };
  log.info('hour scheduled', { site: site.id, hour: curHour, due: due.length, run: run.id });

  for (const { slot, index } of due) {
    const key = `${site.id}:${day}:${index}`;
    if (scheduledKeys.has(key)) continue;
    scheduledKeys.add(key);

    const delayMin = slot.minute - curMin;
    const delayMs = delayMin > 0 ? delayMin * 60000 + randInt(0, 15000) : randInt(500, 25000);
    setTimeout(() => {
      const strategy = pickStrategy(strategies, slot.converting);
      limiter.run(() => runVisit({ site, strategy, links, runId: run.id }))
        .then((r) => { counters.ok += r.ok ? 1 : 0; counters.fail += r.ok ? 0 : 1; })
        .catch((e) => { counters.fail++; log.error('visit threw', { site: site.id, err: e.message }); })
        .finally(() => {
          slot.done = true;
          db.savePlan(site.id, day, plan);
          counters.done++;
          if (counters.done >= counters.total) db.finishRun(run.id, { completed: counters.ok, failed: counters.fail, status: 'done' });
        });
    }, Math.min(delayMs, 59 * 60000));
  }
}

async function tick({ catchUp = false } = {}) {
  const sites = db.listActiveSites();
  log.info('tick', { activeSites: sites.length, catchUp });
  for (const site of sites) {
    await runSiteHour(site, { catchUp }).catch((e) => log.error('runSiteHour failed', { site: site.id, err: e.message }));
  }
}

// ---- on-demand (CLI) ----
async function runNow(siteId, { count = 1, converting } = {}) {
  const site = db.getSite(siteId);
  if (!site) throw new Error('site not found');
  const { strategies, links } = await ensureData(site);
  const n = Math.max(1, Math.min(count, 50));
  const run = db.createRun(site.id, { hour: nowParts(site.timezone || config.defaultTimezone).hour, planned: n, kind: 'manual' });
  const results = [];
  const tasks = [];
  for (let i = 0; i < n; i++) {
    const conv = converting !== undefined ? converting : i < Math.ceil(n * 0.25);
    const strategy = pickStrategy(strategies, conv);
    tasks.push(limiter.run(() => runVisit({ site, strategy, links, runId: run.id })).then((r) => results.push(r)));
  }
  await Promise.allSettled(tasks);
  db.finishRun(run.id, { completed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, status: 'done' });
  return results;
}

// Prime a freshly-created site: crawl + strategies + today's plan (non-blocking caller).
async function primeSite(site) {
  try {
    await ensureData(site, { force: true });
    getOrBuildPlan(site, db.dayKey(new Date(), site.timezone || config.defaultTimezone));
    log.info('site primed', { site: site.id });
  } catch (e) {
    log.error('primeSite failed', { site: site.id, err: e.message });
  }
}

let task = null;
function start() {
  log.info('scheduler starting', { tz: config.timezone, dailyVisits: config.sim.dailyVisits });
  try { const r = db.abortStaleRuns(); if (r && r.changes) log.warn('aborted stale runs at startup', { n: r.changes }); }
  catch (e) { log.error('abortStaleRuns failed', { err: e.message }); }
  tick({ catchUp: true }).catch((e) => log.error('startup tick failed', { err: e.message }));
  task = cron.schedule('0 * * * *', () => tick({ catchUp: false }), { timezone: config.timezone });
}
function stop() { if (task) { task.stop(); task = null; } }

module.exports = { start, stop, tick, runNow, primeSite, ensureData, buildPlan, getOrBuildPlan };
