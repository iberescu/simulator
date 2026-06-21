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
  },
  sim: {
    dailyVisits: int(process.env.DAILY_VISITS, 20),
    convertingVisits: int(process.env.CONVERTING_VISITS, 5),
    refererBase: (process.env.REFERER_BASE || 'https://leadmaker.ai').replace(/\/+$/, ''),
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
  },
  deploy: {
    domain: process.env.DEPLOY_DOMAIN || 'service.layout.ai',
    region: process.env.DEPLOY_REGION || 'fra1',
    size: process.env.DEPLOY_SIZE || 's-2vcpu-4gb',
    image: process.env.DEPLOY_IMAGE || 'ubuntu-24-04-x64',
  },
};

module.exports = config;
