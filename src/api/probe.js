'use strict';
const config = require('../config');
const log = require('../logger').child({ mod: 'probe' });

/*
 * Controlled test target. The simulator can be pointed at /__probe; every hit records the
 * incoming exit IP + user-agent + client hints so an operator can verify that each session
 * comes through a different residential IP / UA. In-memory ring buffer (no persistence).
 *   GET  /__probe[?p=home]   -> minimal HTML page (records the hit)
 *   GET  /__probe/hits       -> recorded hits as JSON (API-key guarded)
 *   POST /__probe/reset      -> clear the buffer (API-key guarded)
 */
const MAX = 1000;
const hits = [];

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || '';
}

function record(req) {
  const h = {
    t: new Date().toISOString(),
    ip: clientIp(req),
    ua: req.headers['user-agent'] || '',
    lang: req.headers['accept-language'] || '',
    sec_ch_ua: req.headers['sec-ch-ua'] || '',
    sec_ch_ua_platform: req.headers['sec-ch-ua-platform'] || '',
    sec_ch_ua_mobile: req.headers['sec-ch-ua-mobile'] || '',
    path: req.path,
    page: String(req.query.p || ''),
    cid: String(req.query.cid || ''),
    utm_source: String(req.query.utm_source || ''),
    referer: req.headers['referer'] || '',
  };
  hits.push(h);
  while (hits.length > MAX) hits.shift();
  return h;
}

function pageHtml(p) {
  const safe = p.replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'home';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Traffic probe — ${safe}</title></head>
<body style="font-family:system-ui,Segoe UI,Arial;max-width:680px;margin:40px auto;padding:0 16px;line-height:1.6">
<h1>Traffic probe</h1>
<p>Controlled simulator test target. This page records the visitor IP + user agent. Section: <b>${safe}</b>.</p>
<nav><a href="/__probe?p=home">Home</a> &middot; <a href="/__probe?p=about">About</a> &middot;
<a href="/__probe?p=pricing">Pricing</a> &middot; <a href="/__probe?p=contact">Contact</a></nav>
<section style="margin-top:24px"><p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(30)}</p></section>
<form method="get" action="/__probe">
<input type="hidden" name="p" value="contact">
<label>Email <input type="email" name="email" placeholder="you@example.com"></label>
<button type="submit">Get started</button>
</form>
</body></html>`;
}

function keyOk(req) {
  if (!config.apiKey) return true;
  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const key = bearer || req.get('x-api-key') || req.query.key || '';
  return key === config.apiKey;
}

function mount(app) {
  app.get('/__probe', (req, res) => { record(req); res.type('html').send(pageHtml(String(req.query.p || 'home'))); });

  app.get('/__probe/hits', (req, res) => {
    if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
    const bySession = {};
    for (const h of hits) {
      const k = h.cid || '(no-cid)';
      if (!bySession[k]) bySession[k] = { cid: k, ips: new Set(), uas: new Set(), count: 0, first: h.t, last: h.t };
      const s = bySession[k];
      s.ips.add(h.ip); s.uas.add(h.ua); s.count++; s.last = h.t;
    }
    const sessions = Object.values(bySession).map((s) => ({
      cid: s.cid, hits: s.count, ips: [...s.ips], user_agents: [...s.uas], first: s.first, last: s.last,
    }));
    res.json({ total_hits: hits.length, sessions, hits: hits.slice().reverse() });
  });

  app.post('/__probe/reset', (req, res) => {
    if (!keyOk(req)) return res.status(401).json({ error: 'unauthorized' });
    hits.length = 0;
    res.json({ ok: true });
  });

  log.info('probe endpoints mounted', { path: '/__probe' });
}

module.exports = { mount };
