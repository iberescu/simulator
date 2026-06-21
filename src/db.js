'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');

let _db = null;

function getDb() {
  if (_db) return _db;
  const dir = path.dirname(config.databasePath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(config.databasePath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 8000');
  _db.pragma('foreign_keys = ON');
  return _db;
}

function migrate() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      customer_name TEXT,
      customer_email TEXT,
      customer_company TEXT,
      notes TEXT,
      daily_visits INTEGER NOT NULL DEFAULT 20,
      converting_visits INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'active',
      timezone TEXT,
      site_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      stopped_at TEXT
    );

    CREATE TABLE IF NOT EXISTS crawls (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source TEXT,
      links TEXT,
      pages TEXT,
      is_ecommerce INTEGER DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS strategies (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      crawl_id TEXT,
      created_at TEXT NOT NULL,
      source TEXT,
      data TEXT,
      is_ecommerce INTEGER DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      day TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (site_id, day)
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      hour INTEGER,
      kind TEXT,
      planned INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running'
    );

    CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      site_id TEXT NOT NULL,
      cid TEXT NOT NULL,
      converting INTEGER DEFAULT 0,
      persona TEXT,
      identity_email TEXT,
      user_agent TEXT,
      device TEXT,
      proxy_label TEXT,
      referer TEXT,
      entry_url TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      pages_visited INTEGER DEFAULT 0,
      actions TEXT,
      status TEXT,
      conversion INTEGER DEFAULT 0,
      conversion_type TEXT,
      email_verified INTEGER DEFAULT 0,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_crawls_site ON crawls(site_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_strategies_site ON strategies(site_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_site ON runs(site_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_visits_site ON visits(site_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_visits_run ON visits(run_id);
  `);

  // Additive migrations for pre-existing databases.
  const ensureColumn = (table, col, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  const vcols = db.prepare('PRAGMA table_info(visits)').all();
  if (vcols.find((c) => c.name === 'sim_id') && !vcols.find((c) => c.name === 'cid')) {
    db.exec('ALTER TABLE visits RENAME COLUMN sim_id TO cid');
  }
  ensureColumn('sites', 'timezone', 'timezone TEXT');
  ensureColumn('visits', 'conversion', 'conversion INTEGER DEFAULT 0');
  ensureColumn('visits', 'conversion_type', 'conversion_type TEXT');
  ensureColumn('visits', 'email_verified', 'email_verified INTEGER DEFAULT 0');
  return db;
}

const uuid = () => crypto.randomUUID();
const newToken = (n = 24) => crypto.randomBytes(n).toString('base64url');
const nowIso = () => new Date().toISOString();

function dayKey(d = new Date(), tz = config.timezone) {
  // YYYY-MM-DD in the given timezone (en-CA formats as ISO date).
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

const b = (v) => (v ? 1 : 0);

// ---------- sites ----------
function createSite(input) {
  const db = getDb();
  const row = {
    id: uuid(),
    url: input.url,
    customer_name: input.customer_name || null,
    customer_email: input.customer_email || null,
    customer_company: input.customer_company || null,
    notes: input.notes || null,
    daily_visits: input.daily_visits || config.sim.dailyVisits,
    converting_visits: input.converting_visits || config.sim.convertingVisits,
    status: 'active',
    timezone: input.timezone || config.defaultTimezone,
    site_token: newToken(),
    created_at: nowIso(),
    updated_at: nowIso(),
    stopped_at: null,
  };
  db.prepare(`INSERT INTO sites
    (id,url,customer_name,customer_email,customer_company,notes,daily_visits,converting_visits,status,timezone,site_token,created_at,updated_at,stopped_at)
    VALUES (@id,@url,@customer_name,@customer_email,@customer_company,@notes,@daily_visits,@converting_visits,@status,@timezone,@site_token,@created_at,@updated_at,@stopped_at)`).run(row);
  return row;
}
const getSite = (id) => getDb().prepare('SELECT * FROM sites WHERE id = ?').get(id);
const getSiteByToken = (token) => getDb().prepare('SELECT * FROM sites WHERE site_token = ?').get(token);
const listSites = () => getDb().prepare('SELECT * FROM sites ORDER BY created_at DESC').all();
const listActiveSites = () => getDb().prepare("SELECT * FROM sites WHERE status = 'active' ORDER BY created_at ASC").all();
function setSiteStatus(id, status) {
  const stopped = status === 'stopped' ? nowIso() : null;
  return getDb().prepare('UPDATE sites SET status=?, stopped_at=?, updated_at=? WHERE id=?')
    .run(status, stopped, nowIso(), id);
}

// ---------- crawls ----------
function saveCrawl(siteId, c) {
  const db = getDb();
  const row = {
    id: uuid(), site_id: siteId, created_at: nowIso(),
    source: c.source || null,
    links: JSON.stringify(c.links || []),
    pages: JSON.stringify(c.pages || []),
    is_ecommerce: b(c.isEcommerce),
    error: c.error || null,
  };
  db.prepare(`INSERT INTO crawls (id,site_id,created_at,source,links,pages,is_ecommerce,error)
    VALUES (@id,@site_id,@created_at,@source,@links,@pages,@is_ecommerce,@error)`).run(row);
  return row;
}
const getLatestCrawl = (siteId) =>
  getDb().prepare('SELECT * FROM crawls WHERE site_id=? ORDER BY created_at DESC LIMIT 1').get(siteId);

// ---------- strategies ----------
function saveStrategies(siteId, s) {
  const db = getDb();
  const row = {
    id: uuid(), site_id: siteId, crawl_id: s.crawlId || null, created_at: nowIso(),
    source: s.source || null,
    data: JSON.stringify(s.data || []),
    is_ecommerce: b(s.isEcommerce),
    error: s.error || null,
  };
  db.prepare(`INSERT INTO strategies (id,site_id,crawl_id,created_at,source,data,is_ecommerce,error)
    VALUES (@id,@site_id,@crawl_id,@created_at,@source,@data,@is_ecommerce,@error)`).run(row);
  return row;
}
const getLatestStrategies = (siteId) =>
  getDb().prepare('SELECT * FROM strategies WHERE site_id=? ORDER BY created_at DESC LIMIT 1').get(siteId);

// ---------- plans ----------
const getPlan = (siteId, day) =>
  getDb().prepare('SELECT * FROM plans WHERE site_id=? AND day=?').get(siteId, day);
function savePlan(siteId, day, data) {
  const db = getDb();
  const row = { id: uuid(), site_id: siteId, day, data: JSON.stringify(data), created_at: nowIso() };
  db.prepare(`INSERT INTO plans (id,site_id,day,data,created_at) VALUES (@id,@site_id,@day,@data,@created_at)
    ON CONFLICT(site_id,day) DO UPDATE SET data=excluded.data`).run(row);
  return row;
}

// ---------- runs ----------
function createRun(siteId, { hour, planned, kind }) {
  const db = getDb();
  const row = { id: uuid(), site_id: siteId, started_at: nowIso(), finished_at: null, hour: hour ?? null, kind: kind || 'scheduled', planned: planned || 0, completed: 0, failed: 0, status: 'running' };
  db.prepare(`INSERT INTO runs (id,site_id,started_at,finished_at,hour,kind,planned,completed,failed,status)
    VALUES (@id,@site_id,@started_at,@finished_at,@hour,@kind,@planned,@completed,@failed,@status)`).run(row);
  return row;
}
function finishRun(runId, { completed, failed, status }) {
  return getDb().prepare('UPDATE runs SET finished_at=?, completed=?, failed=?, status=? WHERE id=?')
    .run(nowIso(), completed || 0, failed || 0, status || 'done', runId);
}
const listRuns = (siteId, limit = 30) =>
  getDb().prepare('SELECT * FROM runs WHERE site_id=? ORDER BY started_at DESC LIMIT ?').all(siteId, limit);
// Any run still 'running' at process startup is orphaned (in-memory timers/visits don't survive a
// restart), so the run would never be finished. Mark them aborted so they don't sit 'running' forever.
function abortStaleRuns() {
  return getDb().prepare("UPDATE runs SET status='aborted', finished_at=? WHERE status='running'").run(nowIso());
}

// ---------- visits ----------
function createVisit(v) {
  const db = getDb();
  const row = {
    id: uuid(), run_id: v.runId || null, site_id: v.siteId, cid: v.cid,
    converting: b(v.converting), persona: v.persona || null, identity_email: v.identityEmail || null,
    user_agent: v.userAgent || null, device: v.device || null, proxy_label: v.proxyLabel || null,
    referer: v.referer || null, entry_url: v.entryUrl || null, started_at: nowIso(),
    finished_at: null, duration_ms: null, pages_visited: 0, actions: '[]', status: 'running', error: null,
  };
  db.prepare(`INSERT INTO visits
    (id,run_id,site_id,cid,converting,persona,identity_email,user_agent,device,proxy_label,referer,entry_url,started_at,finished_at,duration_ms,pages_visited,actions,status,error)
    VALUES (@id,@run_id,@site_id,@cid,@converting,@persona,@identity_email,@user_agent,@device,@proxy_label,@referer,@entry_url,@started_at,@finished_at,@duration_ms,@pages_visited,@actions,@status,@error)`).run(row);
  return row;
}
function finishVisit(visitId, v) {
  return getDb().prepare('UPDATE visits SET finished_at=?, duration_ms=?, pages_visited=?, actions=?, status=?, conversion=?, conversion_type=?, email_verified=?, error=? WHERE id=?')
    .run(nowIso(), v.durationMs || null, v.pagesVisited || 0, JSON.stringify(v.actions || []), v.status || 'completed', v.conversion ? 1 : 0, v.conversionType || null, v.emailVerified ? 1 : 0, v.error || null, visitId);
}
const listVisits = (siteId, limit = 100) =>
  getDb().prepare('SELECT * FROM visits WHERE site_id=? ORDER BY started_at DESC LIMIT ?').all(siteId, limit);
const countVisits = (siteId) =>
  getDb().prepare("SELECT COUNT(*) n, SUM(converting) c, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) ok FROM visits WHERE site_id=?").get(siteId);

function siteStats(siteId) {
  return getDb().prepare(`SELECT
      COUNT(*) AS visits,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(converting) AS converting_visits,
      SUM(conversion) AS conversions,
      SUM(pages_visited) AS pages_hit,
      MIN(started_at) AS first_visit_at,
      MAX(started_at) AS last_visit_at
    FROM visits WHERE site_id=?`).get(siteId) || {};
}
const siteDaily = (siteId, days = 14) =>
  getDb().prepare(`SELECT substr(started_at,1,10) AS day, COUNT(*) AS visits,
      SUM(conversion) AS conversions, SUM(pages_visited) AS pages
    FROM visits WHERE site_id=? GROUP BY day ORDER BY day DESC LIMIT ?`).all(siteId, days);
const conversionsByType = (siteId) =>
  getDb().prepare(`SELECT conversion_type AS type, COUNT(*) AS n
    FROM visits WHERE site_id=? AND conversion_type IS NOT NULL GROUP BY conversion_type ORDER BY n DESC`).all(siteId);
const deviceBreakdown = (siteId) =>
  getDb().prepare(`SELECT device, COUNT(*) AS visits, SUM(conversion) AS conversions
    FROM visits WHERE site_id=? AND device IS NOT NULL GROUP BY device ORDER BY visits DESC`).all(siteId);

module.exports = {
  getDb, migrate, uuid, newToken, nowIso, dayKey,
  createSite, getSite, getSiteByToken, listSites, listActiveSites, setSiteStatus,
  saveCrawl, getLatestCrawl,
  saveStrategies, getLatestStrategies,
  getPlan, savePlan,
  createRun, finishRun, listRuns, abortStaleRuns,
  createVisit, finishVisit, listVisits, countVisits,
  siteStats, siteDaily, conversionsByType, deviceBreakdown,
};
