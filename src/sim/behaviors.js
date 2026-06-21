'use strict';
const config = require('../config');
const h = require('./humanize');
const baseLog = require('../logger').child({ mod: 'behaviors' });

const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

const ADD_TO_CART_RE = /add to (cart|basket|bag|trolley)|add to my (cart|bag)|buy now/i;
const PAYMENT_RE = /card|cc-|cvc|cvv|cardnumber|card-number|card number|expir|security code|routing|iban|account number|sort code/i;

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const textRegex = (t) => new RegExp(escapeRegExp(String(t).slice(0, 50)), 'i');

function lastSegment(t) {
  try {
    const s = String(t).split('?')[0].split('#')[0].replace(/\/+$/, '');
    const parts = s.split('/').filter(Boolean);
    return decodeURIComponent(parts[parts.length - 1] || '').slice(0, 60);
  } catch { return ''; }
}

function sameHost(a, b) {
  try { return new URL(a).hostname.replace(/^www\./, '') === new URL(b).hostname.replace(/^www\./, ''); } catch { return false; }
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await h.sleep(h.randInt(400, 1200));
}

async function navigate(page, url, referer) {
  await page.goto(url, { waitUntil: 'domcontentloaded', referer }).catch(() => {});
  await settle(page);
}

async function firstVisible(locators) {
  for (const loc of locators) {
    try {
      const f = loc.first();
      if ((await f.count()) > 0 && (await f.isVisible().catch(() => false))) return f;
    } catch { /* ignore */ }
  }
  return null;
}

function resolveUrl(target, site, links) {
  if (!target) return null;
  const t = String(target).trim();
  try {
    const u = new URL(t, site.url);
    if (/^https?:$/.test(u.protocol) && sameHost(u.href, site.url)) return u.href;
  } catch { /* ignore */ }
  const hit = (links || []).find((l) => l.includes(t));
  return hit || null;
}

async function findLink(page, target) {
  if (!target) return null;
  const t = String(target).trim();
  const looksPath = /^https?:\/\//i.test(t) || t.startsWith('/') || (t.includes('/') && !t.includes(' '));
  if (!looksPath) {
    const rx = textRegex(t);
    const byRole = await firstVisible([page.getByRole('link', { name: rx }), page.getByRole('button', { name: rx })]);
    if (byRole) return byRole;
    const byText = await firstVisible([page.locator(`a:has-text(${JSON.stringify(t.slice(0, 40))})`)]);
    if (byText) return byText;
  }
  const seg = lastSegment(t);
  if (seg) {
    const byHref = await firstVisible([page.locator(`a[href*="${seg.replace(/"/g, '')}"]`)]);
    if (byHref) return byHref;
  }
  return null;
}

async function randomInternalNav(page, site) {
  let hrefs = [];
  try {
    hrefs = await page.$$eval('a[href]', (as) => as.map((a) => a.href));
  } catch { return false; }
  const cur = page.url();
  const internal = hrefs.filter((href) => {
    if (!/^https?:\/\//.test(href)) return false;
    if (href.split('#')[0] === cur.split('#')[0]) return false;
    if (/\.(jpe?g|png|gif|svg|css|js|pdf|zip|mp4|woff2?)(\?|#|$)/i.test(href)) return false;
    return sameHost(href, site.url);
  });
  if (!internal.length) return false;
  await navigate(page, internal[Math.floor(Math.random() * internal.length)], cur);
  return true;
}

async function clickTarget(page, site, links, target) {
  const loc = await findLink(page, target);
  if (loc) {
    try { await h.moveAndClick(page, loc); await settle(page); return true; } catch { /* fall through */ }
  }
  const url = resolveUrl(target, site, links);
  if (url) { await navigate(page, url, page.url()); return true; }
  return randomInternalNav(page, site);
}

async function hoverTarget(page, target) {
  const loc = await findLink(page, target);
  if (loc) { await h.hover(page, loc).catch(() => {}); return true; }
  return false;
}

async function doSearch(page, query) {
  const q = (query && String(query).trim()) || 'best seller';
  const input = await firstVisible([
    page.getByRole('searchbox'),
    page.locator('input[type="search"]'),
    page.locator('input[name="q"], input[name*="search" i], input[id*="search" i], input[placeholder*="search" i]'),
  ]);
  if (!input) return false;
  await h.humanType(page, input, q);
  await h.sleep(h.randInt(200, 700));
  await page.keyboard.press('Enter');
  await settle(page);
  return true;
}

async function addToCart(page, site, links) {
  const re = ADD_TO_CART_RE;
  let btn = await firstVisible([
    page.getByRole('button', { name: re }),
    page.getByRole('link', { name: re }),
    page.locator('button:has-text("Add to")'),
    page.locator('input[type="submit"][value*="cart" i], input[type="submit"][value*="basket" i]'),
    page.locator('[id*="add-to-cart" i], [class*="add-to-cart" i], [name*="add-to-cart" i]'),
  ]);
  if (!btn) {
    // Probably a listing/category page: open a product first, then look again.
    const product = await firstVisible([
      page.locator('a[href*="/product" i]'),
      page.locator('a[href*="/products/" i]'),
      page.locator('.product_pod a, article.product a, li.product a, .product-card a'),
    ]);
    if (product) {
      try { await h.moveAndClick(page, product); await settle(page); } catch { /* ignore */ }
      btn = await firstVisible([
        page.getByRole('button', { name: re }),
        page.getByRole('link', { name: re }),
        page.locator('button:has-text("Add to")'),
        page.locator('input[type="submit"][value*="basket" i]'),
      ]);
    }
  }
  if (btn) {
    try { await h.moveAndClick(page, btn); await h.think(900, 2200); return true; } catch { /* ignore */ }
  }
  return false;
}

async function viewCart(page, site) {
  const link = await firstVisible([
    page.getByRole('link', { name: /view (cart|basket|bag)|(^|\s)(cart|basket)(\s|$)/i }),
    page.locator('a[href*="cart" i], a[href*="basket" i]'),
    page.getByRole('button', { name: /cart|basket/i }),
  ]);
  if (link) { try { await h.moveAndClick(page, link); await settle(page); return true; } catch { /* ignore */ } }
  for (const p of ['/cart', '/basket', '/checkout/cart']) {
    try {
      const u = new URL(p, site.url).href;
      await navigate(page, u, page.url());
      return true;
    } catch { /* ignore */ }
  }
  return false;
}

async function checkout(page, site, identity) {
  // Navigate to the checkout step. We intentionally avoid clicking "Place order"/"Pay".
  let navigated = false;
  const link = await firstVisible([
    page.getByRole('link', { name: /checkout|proceed to checkout|go to checkout/i }),
    page.getByRole('button', { name: /checkout|proceed to checkout|continue to checkout/i }),
    page.locator('a[href*="checkout" i], button[name*="checkout" i]'),
  ]);
  if (link) {
    try { await h.moveAndClick(page, link); await settle(page); navigated = true; } catch { /* ignore */ }
  }
  if (!navigated) {
    try { await navigate(page, new URL('/checkout', site.url).href, page.url()); navigated = true; } catch { /* ignore */ }
  }
  // Fill shipping/contact details but never submit the order / enter payment.
  const r = await fillBestForm(page, identity, { submit: false, checkout: true });
  return { ok: navigated || r.ok, navigated, detail: r.ok ? `reached_checkout(filled ${r.filled})` : (navigated ? 'reached_checkout' : 'no_checkout') };
}

async function scoreForm(formHandle) {
  try {
    return await formHandle.evaluate((form) => {
      const t = (form.innerText || '').toLowerCase();
      let s = 0;
      if (form.querySelector('input[type=email], input[name*=email i]')) s += 3;
      if (form.querySelector('textarea')) s += 3;
      if (/contact|message|quote|inquiry|enquiry|get in touch|how can we help|request/.test(t)) s += 2;
      if (form.querySelector('input[type=password]')) s -= 6;
      if (form.querySelector('input[type=search], [role=search]')) s -= 3;
      if (/log ?in|sign ?in|search|newsletter|subscribe/.test(t)) s -= 2;
      s += Math.min(form.querySelectorAll('input, textarea, select').length, 6) * 0.2;
      return s;
    });
  } catch { return -1; }
}

async function fillSelect(el, text, identity) {
  let opts;
  try { opts = await el.evaluate((s) => Array.from(s.options).map((o) => ({ v: o.value, t: (o.textContent || '').trim() }))); } catch { return false; }
  if (!opts || !opts.length) return false;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const isPlaceholder = (o) => !o.v || /^(select|choose|please|--)/i.test(o.t) || o.t === '';
  let target = null;
  if (/state|province|region|county/.test(text)) {
    const full = STATES[identity.state] ? STATES[identity.state].toLowerCase() : '';
    target = opts.find((o) => norm(o.v) === norm(identity.state) || norm(o.t) === norm(identity.state) || (full && (norm(o.t) === full || norm(o.v) === full)));
  } else if (/country/.test(text)) {
    target = opts.find((o) => /^(us|usa)$/i.test(o.v) || /united states/i.test(o.t) || norm(o.v) === 'united states');
  }
  if (!target) target = opts.find((o) => !isPlaceholder(o));
  if (!target) return false;
  try { await el.selectOption(target.v ? { value: target.v } : { label: target.t }); return true; }
  catch { try { await el.selectOption({ label: target.t }); return true; } catch { return false; } }
}

async function fillField(page, el, identity) {
  let meta;
  try {
    meta = await el.evaluate((n) => {
      const lbl = (n.labels && n.labels[0] && (n.labels[0].innerText || n.labels[0].textContent)) || '';
      return {
        tag: n.tagName.toLowerCase(), type: (n.getAttribute('type') || '').toLowerCase(),
        name: n.getAttribute('name') || '', id: n.id || '', ph: n.getAttribute('placeholder') || '',
        aria: n.getAttribute('aria-label') || '', ac: n.getAttribute('autocomplete') || '',
        required: !!n.required, label: lbl,
      };
    });
  } catch { return false; }
  if (!(await el.isVisible().catch(() => false))) return false;
  const type = meta.type;
  if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password', 'range', 'color'].includes(type)) return false;
  const text = [meta.name, meta.id, meta.ph, meta.aria, meta.ac, meta.label].join(' ').toLowerCase();
  if (PAYMENT_RE.test(text)) return false; // never touch payment fields
  if (meta.tag === 'select') return fillSelect(el, text, identity);
  if (type === 'checkbox') {
    if (/agree|terms|consent|privacy|gdpr|policy|i confirm|not a robot/.test(text)) { await el.check().catch(() => {}); return true; }
    return false;
  }
  if (type === 'radio') return false;

  let value = null;
  if (type === 'email' || /e-?mail/.test(text)) value = identity.email;
  else if (/first.?name|fname|given/.test(text)) value = identity.firstName;
  else if (/last.?name|lname|surname|family/.test(text)) value = identity.lastName;
  else if (/full.?name|your name|contact name|^name$|recipient|attention/.test(text) || (/name/.test(text) && !/user|company|file|card|screen/.test(text))) value = identity.fullName;
  else if (type === 'tel' || /phone|tel|mobile|cell/.test(text)) value = identity.phone;
  else if (/company|organi[sz]ation|business/.test(text)) value = identity.company;
  else if (/address.?2|apt|suite|unit|line ?2/.test(text)) value = identity.address2 || 'Suite 200';
  else if (/address|street|addr|line ?1/.test(text)) value = identity.address1;
  else if (/city|town|suburb/.test(text)) value = identity.city;
  else if (/zip|postal|postcode|post code/.test(text)) value = identity.zip;
  else if (/state|province|region/.test(text)) value = identity.state;
  else if (/country/.test(text)) value = identity.country;
  else if (/subject/.test(text)) value = identity.subject;
  else if (meta.tag === 'textarea' || /message|comment|inquir|enquir|question|details|notes?|how can we help|tell us/.test(text)) value = identity.inquiry;
  else if (/quantity|qty/.test(text)) value = '1';
  else if (/search|^q$/.test(text)) return false;
  else if (type === 'number') return false;
  else if (type === 'url') value = 'https://example.com';
  else if (meta.required) value = identity.fullName; // benign filler for required unknowns
  else return false;

  if (value == null) return false;
  try { await h.humanType(page, el, value); return true; } catch { return false; }
}

async function findSubmit(scope) {
  const direct = ['button[type=submit]', 'input[type=submit]', 'button[name*="submit" i]'];
  for (const sel of direct) {
    try { const el = await scope.$(sel); if (el && await el.isVisible().catch(() => false)) return el; } catch { /* ignore */ }
  }
  let candidates = [];
  try { candidates = await scope.$$('button, input[type=button], a[role=button]'); } catch { /* ignore */ }
  for (const el of candidates) {
    const t = await el.evaluate((n) => (n.innerText || n.value || '').trim().toLowerCase()).catch(() => '');
    if (/send|submit|request|get a quote|get quote|contact|message|inquir|enquir|get started/.test(t) && !/search|log ?in|sign ?in|subscribe/.test(t)) {
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return null;
}

async function fillBestForm(page, identity, { submit, checkout: isCheckout } = {}) {
  let forms = [];
  try { forms = await page.$$('form'); } catch { /* ignore */ }
  let best = null;
  let bestScore = -1;
  for (const f of forms) {
    if (!(await f.isVisible().catch(() => false))) continue;
    const sc = await scoreForm(f);
    if (sc > bestScore) { bestScore = sc; best = f; }
  }
  const scope = best || page;
  let fields = [];
  try { fields = await scope.$$('input, textarea, select'); } catch { /* ignore */ }
  let filled = 0;
  for (const el of fields) {
    if (await fillField(page, el, identity)) { filled++; await h.sleep(h.randInt(120, 400)); }
  }
  if (!filled) return { ok: false, filled: 0, submitted: false, detail: 'no_fields' };

  let submitted = false;
  if (submit && config.sim.submitForms && !isCheckout) {
    const sb = await findSubmit(scope);
    if (sb) {
      try { await h.moveAndClick(page, sb); await settle(page); submitted = true; } catch { /* ignore */ }
    }
  }
  return { ok: true, filled, submitted, detail: `filled ${filled}${submitted ? ', submitted' : ''}` };
}

async function executeStrategy(page, opts) {
  const { site, strategy, links, identity } = opts;
  const log = opts.vlog || baseLog;
  const actions = [];
  let pagesVisited = 1;
  const deadline = Date.now() + config.sim.maxVisitMs;
  const rec = (action, ok, detail) => actions.push({ action, ok, detail, t: new Date().toISOString() });

  await h.think(800, 2200);
  await h.humanScroll(page, { steps: h.randInt(1, 3) }).catch(() => {});

  for (const step of strategy.steps.slice(0, config.sim.maxStepsPerVisit)) {
    if (Date.now() > deadline) { rec('budget_exceeded', false); break; }
    try {
      switch (step.action) {
        case 'scroll': await h.humanScroll(page); rec('scroll', true); break;
        case 'wait': await h.think(1500, 5000); rec('wait', true); break;
        case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout: config.sim.navTimeoutMs }).catch(() => {}); await settle(page); rec('back', true); break;
        case 'hover': rec('hover', await hoverTarget(page, step.target), step.target); break;
        case 'visit': { const ok = await (async () => { const u = resolveUrl(step.target, site, links); if (u) { await navigate(page, u, page.url()); return true; } return false; })(); if (ok) pagesVisited++; rec('visit', ok, step.target); break; }
        case 'click': { const ok = await clickTarget(page, site, links, step.target); if (ok) pagesVisited++; rec('click', ok, step.target); break; }
        case 'search': rec('search', await doSearch(page, step.value || step.target), step.value || step.target); break;
        case 'add_to_cart': rec('add_to_cart', await addToCart(page, site, links)); break;
        case 'view_cart': { const ok = await viewCart(page, site); if (ok) pagesVisited++; rec('view_cart', ok); break; }
        case 'checkout': { const r = await checkout(page, site, identity); if (r.navigated) pagesVisited++; rec('checkout', r.ok, r.detail); break; }
        case 'fill_form':
        case 'price_inquiry': { const r = await fillBestForm(page, identity, { submit: true }); rec(step.action, r.ok, r.detail); break; }
        default: rec(step.action, false, 'unknown_action');
      }
    } catch (e) {
      rec(step.action, false, (e && e.message || 'error').slice(0, 160));
    }
    await h.think(700, 2600);
  }

  // brief closing dwell
  await h.sleep(h.randInt(1500, 5000));
  log.debug('strategy executed', { pagesVisited, actions: actions.length });
  return { actions, pagesVisited };
}

module.exports = { executeStrategy, fillBestForm, addToCart, checkout };
