'use strict';
const config = require('../config');
const log = require('../logger').child({ mod: 'gemini' });

const ACTIONS = ['visit', 'scroll', 'click', 'hover', 'search', 'add_to_cart', 'view_cart', 'checkout', 'fill_form', 'price_inquiry', 'wait', 'back'];

const SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      persona: { type: 'STRING', description: 'short persona description' },
      device: { type: 'STRING', enum: ['desktop', 'mobile'] },
      intent: { type: 'STRING' },
      converting: { type: 'BOOLEAN' },
      entry: { type: 'STRING', description: 'a URL/path from the provided list, or "homepage"' },
      dwell_seconds: { type: 'INTEGER' },
      steps: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', enum: ACTIONS },
            target: { type: 'STRING', description: 'link text/path or UI hint' },
            value: { type: 'STRING', description: 'optional input, e.g. search query' },
            note: { type: 'STRING' },
          },
          required: ['action'],
        },
      },
      notes: { type: 'STRING' },
    },
    required: ['persona', 'device', 'converting', 'entry', 'steps'],
  },
};

function buildPrompt(site, crawl) {
  const linkList = (crawl.links || []).map((l, i) => `${i + 1}. ${l}`).join('\n');
  const content = (crawl.pages || [])
    .map((p) => `URL: ${p.url}\n${(p.text || '').slice(0, 1500)}`)
    .join('\n\n---\n\n')
    .slice(0, 9000);

  return `You are a senior web-analytics and UX researcher. A customer wants to model realistic organic visitor behaviour on their website BEFORE go-live, to validate analytics, funnels and conversion tracking.

Website: ${site.url}
Detected as e-commerce: ${crawl.isEcommerce ? 'yes' : 'no / unknown'}

Discovered pages/links:
${linkList || '(none discovered)'}

Page content excerpts:
${content || '(none)'}

Produce 6 to 9 distinct visitor BEHAVIOR STRATEGIES that mimic real humans browsing THIS site. Requirements:
- Diverse personas (new vs returning, mobile vs desktop, quick bounce vs deep researcher, comparison shopper, etc).
- Each strategy is an ordered list of 4-9 concrete steps using ONLY these actions: ${ACTIONS.join(', ')}.
- "target" must reference a real link/path from the list above (use the path), or a clear UI hint (e.g. "Add to cart button", "Contact form", "Search box", "Pricing link").
- If the site IS e-commerce, the converting strategies must include add_to_cart, view_cart and checkout.
- If the site is NOT e-commerce, the converting strategies must use fill_form and/or price_inquiry (contact / quote / demo / pricing-request forms).
- Mark roughly one third of strategies converting:true (high intent). The rest converting:false (browse / scroll / bounce).
- dwell_seconds realistic (10-180).
Return ONLY the JSON array.`;
}

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function sanitize(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 9).map((s) => ({
    persona: String(s.persona || 'Visitor').slice(0, 120),
    device: s.device === 'mobile' ? 'mobile' : (s.device === 'desktop' ? 'desktop' : undefined),
    intent: String(s.intent || '').slice(0, 160),
    converting: !!s.converting,
    entry: String(s.entry || 'homepage').slice(0, 400),
    dwell_seconds: clampInt(s.dwell_seconds, 5, 240, 45),
    steps: Array.isArray(s.steps)
      ? s.steps.slice(0, 14)
          .filter((st) => st && ACTIONS.includes(st.action))
          .map((st) => ({
            action: st.action,
            target: st.target ? String(st.target).slice(0, 300) : undefined,
            value: st.value ? String(st.value).slice(0, 200) : undefined,
            note: st.note ? String(st.note).slice(0, 200) : undefined,
          }))
      : [],
    notes: String(s.notes || '').slice(0, 240),
  })).filter((s) => s.steps.length);
}

function fallbackStrategies(site, crawl, reason) {
  const links = crawl.links || [];
  const inner = links.filter((l, i) => i > 0);
  const p = (i) => inner[i % Math.max(1, inner.length)] || 'homepage';
  const ecom = crawl.isEcommerce;

  const strategies = [
    {
      persona: 'New desktop visitor, casual browse', device: 'desktop', converting: false, entry: 'homepage', dwell_seconds: 50,
      steps: [
        { action: 'scroll' }, { action: 'click', target: p(0) }, { action: 'scroll' },
        { action: 'wait' }, { action: 'click', target: p(1) }, { action: 'scroll' },
      ],
    },
    {
      persona: 'Mobile visitor, quick bounce', device: 'mobile', converting: false, entry: 'homepage', dwell_seconds: 18,
      steps: [{ action: 'scroll' }, { action: 'wait' }, { action: 'scroll' }],
    },
    {
      persona: 'Returning researcher, deep read', device: 'desktop', converting: false, entry: 'homepage', dwell_seconds: 120,
      steps: [
        { action: 'click', target: p(2) }, { action: 'scroll' }, { action: 'click', target: p(3) },
        { action: 'scroll' }, { action: 'back' }, { action: 'click', target: p(0) }, { action: 'scroll' },
      ],
    },
    {
      persona: 'Mobile comparison shopper', device: 'mobile', converting: false, entry: 'homepage', dwell_seconds: 70,
      steps: [{ action: 'click', target: p(1) }, { action: 'scroll' }, { action: 'click', target: p(2) }, { action: 'scroll' }],
    },
  ];

  if (ecom) {
    strategies.push({
      persona: 'High-intent buyer (desktop)', device: 'desktop', converting: true, entry: 'homepage', dwell_seconds: 150,
      steps: [
        { action: 'click', target: p(0), note: 'browse a product/collection' }, { action: 'scroll' },
        { action: 'add_to_cart', target: 'Add to cart button' }, { action: 'view_cart', target: 'Cart' },
        { action: 'checkout', target: 'Checkout button' }, { action: 'fill_form', note: 'shipping/billing details' },
      ],
    });
    strategies.push({
      persona: 'Mobile buyer, buy now', device: 'mobile', converting: true, entry: 'homepage', dwell_seconds: 95,
      steps: [
        { action: 'click', target: p(1) }, { action: 'add_to_cart', target: 'Add to cart button' },
        { action: 'view_cart', target: 'Cart' }, { action: 'checkout', target: 'Checkout' }, { action: 'fill_form' },
      ],
    });
  } else {
    strategies.push({
      persona: 'Lead requesting a quote (desktop)', device: 'desktop', converting: true, entry: 'homepage', dwell_seconds: 110,
      steps: [
        { action: 'click', target: p(0) }, { action: 'scroll' },
        { action: 'price_inquiry', target: 'Contact / quote form' }, { action: 'fill_form', note: 'contact form' },
      ],
    });
    strategies.push({
      persona: 'Mobile lead, contact form', device: 'mobile', converting: true, entry: 'homepage', dwell_seconds: 80,
      steps: [
        { action: 'click', target: p(1) }, { action: 'scroll' },
        { action: 'fill_form', target: 'Contact form' },
      ],
    });
  }

  log.warn('using fallback strategies', { reason, count: strategies.length, ecom });
  return { data: sanitize(strategies), source: 'fallback', isEcommerce: !!ecom, error: reason };
}

async function generateStrategies(site, crawl) {
  if (!config.gemini.apiKey) return fallbackStrategies(site, crawl, 'no-api-key');
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
    const body = {
      contents: [{ parts: [{ text: buildPrompt(site, crawl) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: SCHEMA,
        temperature: 0.95,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 60000);
    let json;
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    } finally {
      clearTimeout(to);
    }
    const cand = json.candidates && json.candidates[0];
    const text = (cand && cand.content && cand.content.parts || []).map((p) => p.text || '').join('');
    let data = JSON.parse(text);
    if (!Array.isArray(data)) data = data.strategies || data.items || [];
    data = sanitize(data);
    if (!data.length) throw new Error('empty/invalid strategies');
    log.info('gemini strategies generated', { count: data.length, model: config.gemini.model });
    return { data, source: 'gemini', isEcommerce: crawl.isEcommerce };
  } catch (e) {
    return fallbackStrategies(site, crawl, `gemini: ${e.message}`);
  }
}

module.exports = { generateStrategies, fallbackStrategies, ACTIONS, buildPrompt };
