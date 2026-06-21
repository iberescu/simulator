'use strict';
require('dotenv').config();

const bool = (v, def = false) => {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const int = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};
const list = (v) => String(v || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
const hostOf = (u, def) => { try { return new URL(u).hostname; } catch { return def; } };

const config = {
  port: int(process.env.PORT, 8080),
  apiKey: process.env.API_KEY || '',
  logLevel: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  timezone: process.env.TZ || 'UTC',
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'America/New_York',
  databasePath: process.env.DATABASE_PATH || './data/campaigns.db',
  schedulerEnabled: bool(process.env.SCHEDULER_ENABLED, true),

  cloudflare: {
    accountId: process.env.CF_ACCOUNT_ID || '',
    apiToken: process.env.CF_API_TOKEN || '',
    // DNS operations (deploy) can use a separate token; falls back to the crawl token.
    dnsToken: process.env.CF_DNS_TOKEN || process.env.CF_API_TOKEN || '',
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },
  digitalOcean: {
    token: process.env.DIGITALOCEAN_TOKEN || '',
  },
  email: {
    // 'gmail' = raw per-person (james.carter47@gmail.com); 'gmail-alias' = base+tag@gmail.com; 'domain' = EMAIL_DOMAINS
    mode: (process.env.EMAIL_MODE || 'gmail').toLowerCase(),
    gmailBase: process.env.GMAIL_BASE || '',
    domains: list(process.env.EMAIL_DOMAINS || 'gmail.com'),
    verify: (process.env.EMAIL_VERIFY || 'mx').toLowerCase(), // mx | abstract | zerobounce | none
    verifyApiKey: process.env.EMAIL_VERIFY_API_KEY || '',
  },
  proxy: {
    enabled: bool(process.env.PROXY_ENABLED, false),
    server: process.env.PROXY_SERVER || '',
    username: process.env.PROXY_USERNAME || '',
    password: process.env.PROXY_PASSWORD || '',
    list: list(process.env.PROXY_LIST),
    rotateMinutes: int(process.env.PROXY_ROTATE_MINUTES, 10),
    sessionParam: process.env.PROXY_SESSION_PARAM || '',
    // Residential geo-targeting + sticky sessions (Oxylabs convention:
    // customer-USER-cc-US-sessid-<id>-sesstime-<minutes>).
    country: (process.env.PROXY_COUNTRY || '').trim().toUpperCase(),
    sessionMinutes: int(process.env.PROXY_SESSION_MINUTES, 0), // Oxylabs `sesstime`: how long an IP is held
    perSession: bool(process.env.PROXY_PER_SESSION, false),    // true = fresh sticky IP per visit (vs time-bucketed)
  },
  sim: {
    dailyVisits: int(process.env.DAILY_VISITS, 20),
    convertingVisits: int(process.env.CONVERTING_VISITS, 5),
    refererBase: (process.env.REFERER_BASE || 'https://leadmaker.ai').replace(/\/+$/, ''),
    // utm_source defaults to the referer host so the campaign tag and the Referer stay in sync.
    utmSource: process.env.UTM_SOURCE || hostOf(process.env.REFERER_BASE || 'https://leadmaker.ai', 'leadmaker.ai'),
    appendUtm: bool(process.env.APPEND_UTM, true),
    submitForms: bool(process.env.SUBMIT_FORMS, true),
    completePayment: bool(process.env.COMPLETE_PAYMENT, false),
    emailDomains: list(process.env.EMAIL_DOMAINS || process.env.TEST_EMAIL_DOMAIN || 'layout.ai'),
    maxConcurrentVisits: int(process.env.MAX_CONCURRENT_VISITS, 2),
    headless: bool(process.env.HEADLESS, true),
    navTimeoutMs: int(process.env.NAV_TIMEOUT_MS, 45000),
    crawlLinksMin: int(process.env.CRAWL_LINKS_MIN, 5),
    crawlLinksMax: int(process.env.CRAWL_LINKS_MAX, 10),
    strategyTtlHours: int(process.env.STRATEGY_TTL_HOURS, 24),
    maxStepsPerVisit: int(process.env.MAX_STEPS_PER_VISIT, 14),
    maxVisitMs: int(process.env.MAX_VISIT_MS, 210000),
    // Target dwell per visit: each session lasts a random duration in [min, max] so the
    // sticky residential IP maps 1:1 to one browsing session (rotate ~every 3 min).
    sessionMinMs: int(process.env.SESSION_MIN_SECONDS, 120) * 1000,
    sessionMaxMs: int(process.env.SESSION_MAX_SECONDS, 180) * 1000,
    // Stage entry as a real ad click via the referrer page (Referer + Sec-Fetch-Site coherent).
    // Only enable when REFERER_BASE actually serves (<400); otherwise a clean direct entry (no
    // forged Referer) is used so Sec-Fetch-Site: none stays consistent.
    referrerClick: bool(process.env.REFERRER_CLICK, false),
  },
  deploy: {
    domain: process.env.DEPLOY_DOMAIN || 'service.layout.ai',
    region: process.env.DEPLOY_REGION || 'fra1',
    size: process.env.DEPLOY_SIZE || 's-2vcpu-4gb',
    image: process.env.DEPLOY_IMAGE || 'ubuntu-24-04-x64',
  },
};

module.exports = config;
