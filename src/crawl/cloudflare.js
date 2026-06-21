'use strict';
const config = require('../config');
const log = require('../logger').child({ mod: 'crawl' });

const ASSET_RE = /\.(jpe?g|png|gif|svg|webp|ico|css|js|mjs|pdf|zip|gz|mp4|webm|mp3|wav|woff2?|ttf|eot|xml|rss|json|map|avif|dmg|exe)(\?|#|$)/i;
const ECOM_HINTS = /(add[\-_ ]?to[\-_ ]?cart|add-to-bag|\/cart|\/checkout|\/basket|\/collections?\/|\/products?\/|\/shop\b|add_to_cart|data-product|sku|woocommerce|shopify|snipcart|bigcommerce|magento|"price"|add to basket)/i;
const PRIORITY_RE = /(product|shop|store|collection|catalog|pricing|price|plans|service|contact|about|quote|cart|checkout|book|demo|feature|solution|menu|order)/i;

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function cloudflareConfigured() {
  return !!(config.cloudflare.accountId && config.cloudflare.apiToken);
}

async function cfBrowserRender(endpoint, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CF_BASE}/accounts/${config.cloudflare.accountId}/browser-rendering/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.cloudflare.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) {
      const msg = (json.errors && json.errors.map((e) => e.message).join('; ')) || `HTTP ${res.status}`;
      throw new Error(`Cloudflare ${endpoint}: ${msg}`);
    }
    return json.result;
  } finally {
    clearTimeout(to);
  }
}

async function cfLinks(url) {
  const result = await cfBrowserRender('links', { url });
  const arr = Array.isArray(result) ? result : (result && (result.links || result.urls)) || [];
  return arr.map((x) => (typeof x === 'string' ? x : (x && (x.url || x.href)))).filter(Boolean);
}

async function cfMarkdown(url) {
  const result = await cfBrowserRender('markdown', { url });
  return typeof result === 'string' ? result : (result && (result.markdown || result.content)) || '';
}

async function fetchHtml(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const ct = res.headers.get('content-type') || '';
    if (ct && !/(html|xml)/i.test(ct)) return { ok: false, html: '', status: res.status, finalUrl: res.url };
    const html = await res.text();
    return { ok: res.ok, html, status: res.status, finalUrl: res.url };
  } catch (e) {
    return { ok: false, html: '', error: e.message };
  } finally {
    clearTimeout(to);
  }
}

function extractLinks(html) {
  const out = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtml(m[1]).slice(0, 160) : '';
}

function normalizeLinks(base, raw, maxLinks) {
  let baseU;
  try { baseU = new URL(base); } catch { return [base]; }
  const baseHost = baseU.hostname.replace(/^www\./, '');
  const home = `${baseU.origin}/`;
  const seen = new Set([`${baseU.origin}/`]);
  const prioritized = [];
  const normal = [];
  for (const r of raw) {
    let u;
    try { u = new URL(r, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname.replace(/^www\./, '');
    if (host !== baseHost && !host.endsWith(`.${baseHost}`)) continue;
    if (ASSET_RE.test(u.pathname)) continue;
    if (u.pathname === '/' || u.pathname === '') continue;
    const key = u.origin + u.pathname.replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const full = u.origin + u.pathname + (u.search || '');
    if (PRIORITY_RE.test(u.pathname)) prioritized.push(full);
    else normal.push(full);
  }
  return [home, ...prioritized, ...normal].slice(0, maxLinks);
}

async function crawlSite(url, { maxLinks } = {}) {
  const limit = Math.min(config.sim.crawlLinksMax, Math.max(config.sim.crawlLinksMin, maxLinks || config.sim.crawlLinksMax));
  let links = [];
  let pages = [];
  let source = null;
  const errs = [];

  if (cloudflareConfigured()) {
    try {
      const raw = await cfLinks(url);
      links = normalizeLinks(url, raw, limit);
      source = 'cloudflare';
      const mdTargets = links.slice(0, 4);
      for (let i = 0; i < mdTargets.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1500)); // pace to respect Browser-Rendering rate limits
        try {
          const md = await cfMarkdown(mdTargets[i]);
          if (md) pages.push({ url: mdTargets[i], text: md.slice(0, 4000) });
        } catch (e) { errs.push(`md ${mdTargets[i]}: ${e.message}`); }
      }
    } catch (e) {
      errs.push(`cf: ${e.message}`);
      log.warn('cloudflare crawl failed; falling back to direct fetch', { url, err: e.message });
    }
  }

  if (!links.length || !pages.length) {
    source = source ? `${source}+fetch` : 'fetch';
    const home = await fetchHtml(url);
    if (home.html) {
      if (!links.length) links = normalizeLinks(home.finalUrl || url, extractLinks(home.html), limit);
      pages.push({ url: home.finalUrl || url, title: extractTitle(home.html), text: stripHtml(home.html).slice(0, 4000) });
      for (const t of links.filter((l) => l !== (home.finalUrl || url) && l !== url).slice(0, 3)) {
        const r = await fetchHtml(t);
        if (r.html) pages.push({ url: t, title: extractTitle(r.html), text: stripHtml(r.html).slice(0, 3000) });
      }
    } else {
      errs.push(`fetch home failed: ${home.error || home.status}`);
    }
  }

  if (!links.length) links = [url];

  const blob = `${links.join(' ')} ${pages.map((p) => p.text || '').join(' ')}`.toLowerCase();
  const isEcommerce = ECOM_HINTS.test(blob);

  log.info('crawl complete', { url, source, links: links.length, pages: pages.length, isEcommerce });
  return { source, links, pages, isEcommerce, error: errs.length ? errs.join(' | ') : null };
}

module.exports = { crawlSite, cloudflareConfigured, normalizeLinks, stripHtml, extractLinks };
