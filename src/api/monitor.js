'use strict';
/*
 * Basic-auth-gated live monitor, mounted on the existing API app.
 *   GET /__monitor                 -> dashboard HTML
 *   GET /__monitor/api/requests    -> recent inbound requests (in-memory ring buffer)
 *   GET /__monitor/api/cron        -> scheduler/cron state (active campaigns, runs, counts)
 *   GET /__monitor/api/visits      -> recent visits w/ pages + event sequence + events funnel
 *
 * Auth: HTTP Basic using MONITOR_USER + MONITOR_PASS (env). Browser shows a login prompt;
 * once entered, the credentials are reused for the page's API calls automatically.
 * If either is unset the whole surface returns 404 (disabled). No SSH key, no docker socket
 * — it only reads in-process state + its own SQLite. Does NOT expose persona emails.
 */
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

const USER = process.env.MONITOR_USER || '';
const PASS = process.env.MONITOR_PASS || '';
const MAX = 500;
const BUF = [];

function record(e) { BUF.push(e); if (BUF.length > MAX) BUF.shift(); }

function tse(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

function guard(req, res, next) {
  if (!USER || !PASS) return res.status(404).json({ error: 'not found' }); // monitor disabled
  const m = (req.get('authorization') || '').match(/^Basic\s+(.+)$/i);
  if (m) {
    let dec = '';
    try { dec = Buffer.from(m[1], 'base64').toString('utf8'); } catch { dec = ''; }
    const i = dec.indexOf(':');
    const u = i >= 0 ? dec.slice(0, i) : '';
    const p = i >= 0 ? dec.slice(i + 1) : '';
    if (tse(u, USER) && tse(p, PASS)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="simulator monitor", charset="UTF-8"');
  return res.status(401).json({ error: 'unauthorized' });
}

// Capture every inbound request into the ring buffer (excluding the monitor's own traffic).
function capture(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path && req.path.indexOf('/__monitor') === 0) return;
    record({ t: new Date().toISOString(), m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - start });
  });
  next();
}

function recentRequests() {
  const reqs = BUF.slice(-150).reverse();
  const byStatus = {};
  for (const x of reqs) byStatus[x.s] = (byStatus[x.s] || 0) + 1;
  return { window: 'since app restart', total: BUF.length, shown: reqs.length, byStatus, requests: reqs };
}

function cronState() {
  const d = db.getDb();
  const active = db.listActiveSites().map((s) => ({ id: s.id, url: s.url, status: s.status, daily_visits: s.daily_visits, timezone: s.timezone, created_at: s.created_at }));
  const runs = d.prepare("SELECT r.site_id, s.url url, r.hour, r.kind, r.planned, r.completed, r.failed, r.status, r.started_at, r.finished_at FROM runs r LEFT JOIN sites s ON s.id=r.site_id ORDER BY r.started_at DESC LIMIT 25").all();
  const visits = d.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed, SUM(conversion) conversions, MAX(started_at) last FROM visits").get();
  const sites = d.prepare("SELECT COUNT(*) n FROM sites").get().n;
  return {
    schedule: '0 * * * *  (top of every hour, ' + config.timezone + ')',
    scheduler_enabled: config.schedulerEnabled,
    server_time: new Date().toISOString(),
    lastRun: runs[0] || null,
    active, runs, visits, sites,
  };
}

// Recent visits with their pages + event sequence, plus an events funnel. No persona emails.
function visitsFeed() {
  const d = db.getDb();
  const rows = d.prepare("SELECT v.cid, s.url url, v.converting, v.conversion, v.conversion_type, v.status, v.device, v.proxy_label, v.entry_url, v.pages_visited, v.duration_ms, v.started_at, v.actions FROM visits v LEFT JOIN sites s ON s.id=v.site_id ORDER BY v.started_at DESC LIMIT 120").all();
  const summary = {};
  const visits = [];
  rows.forEach((v, idx) => {
    let acts = [];
    try { acts = JSON.parse(v.actions) || []; } catch { acts = []; }
    for (const a of acts) {
      const k = a.action || 'unknown';
      summary[k] = summary[k] || { attempts: 0, ok: 0 };
      summary[k].attempts += 1;
      if (a.ok !== false) summary[k].ok += 1;
    }
    if (idx < 50) {
      visits.push({
        cid: v.cid, url: v.url, device: v.device, proxy: v.proxy_label,
        converting: !!v.converting, conversion: !!v.conversion, type: v.conversion_type,
        status: v.status, pages: v.pages_visited, sec: v.duration_ms ? Math.round(v.duration_ms / 1000) : null,
        entry: v.entry_url, started_at: v.started_at,
        events: acts.map((a) => ({ action: a.action, ok: a.ok !== false, detail: a.detail || '' })),
      });
    }
  });
  return { events_summary: summary, sampled: rows.length, visits };
}

function mount(app) {
  app.use(capture);
  app.get('/__monitor', guard, (req, res) => res.type('html').send(HTML));
  app.get('/__monitor/api/requests', guard, (req, res) => res.json(recentRequests()));
  app.get('/__monitor/api/cron', guard, (req, res) => { try { res.json(cronState()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.get('/__monitor/api/visits', guard, (req, res) => { try { res.json(visitsFeed()); } catch (e) { res.status(500).json({ error: e.message }); } });
}

module.exports = { mount, _buf: BUF };

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulator monitor</title>
<style>
  :root{--bg:#0e1116;--card:#161b22;--line:#222b36;--fg:#e6edf3;--mut:#8b98a5;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--info:#58a6ff;--acc:#bc8cff}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,Segoe UI,Roboto,Arial}
  header{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
  header h1{font-size:15px;margin:0;font-weight:600}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--mut);display:inline-block}
  .dot.on{background:var(--ok);box-shadow:0 0 6px var(--ok)} .dot.off{background:var(--bad)}
  .spacer{flex:1}.muted{color:var(--mut)}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
  main{padding:14px;display:flex;flex-direction:column;gap:14px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
  @media(max-width:980px){.grid{grid-template-columns:1fr}}
  section{background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden}
  h2{font-size:13px;margin:0;padding:10px 12px;border-bottom:1px solid var(--line)}
  .body{padding:10px 12px;max-height:46vh;overflow:auto}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:var(--mut);font-weight:500;padding:4px 6px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card)}
  td{padding:4px 6px;border-bottom:1px solid #1b2230;vertical-align:top}
  .path{font-family:ui-monospace,monospace;word-break:break-all;color:#cdd9e5}
  tr.s2 td:last-child{color:var(--ok)} tr.s3 td:last-child{color:var(--info)} tr.s4 td:last-child{color:var(--warn)} tr.s5 td:last-child{color:var(--bad)}
  .pill{display:inline-block;padding:1px 8px;border-radius:10px;background:#1f2733;margin:0 6px 6px 0;font-size:12px}
  .pill.s2{color:var(--ok)} .pill.s4{color:var(--warn)} .pill.s5{color:var(--bad)} .pill.s3{color:var(--info)} .pill b{color:var(--ok)}
  .bad{color:var(--bad)} .ok{color:var(--ok)}
  .kv{display:flex;gap:18px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line);font-size:12.5px}
  .kv b{font-weight:600}
  button{background:#1f2733;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
  .visit{padding:8px 0;border-bottom:1px solid #1b2230}
  .vh{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
  .vh b{font-weight:600}
  .vlanding{font-size:11.5px;margin:2px 0 4px}
  .tag{display:inline-block;padding:0 7px;border-radius:9px;font-size:11px;background:#1f2733}
  .tag.conv{color:var(--acc)} .tag.won{color:var(--ok);background:#13361f} .tag.ok{color:var(--ok)} .tag.bad{color:var(--bad)} .tag.mut{color:var(--mut)}
  .evrow{display:flex;flex-wrap:wrap;align-items:center;gap:2px}
  .ev{display:inline-block;padding:1px 7px;border-radius:6px;background:#1b2434;font-size:11.5px;font-family:ui-monospace,monospace}
  .ev i{color:var(--mut);font-style:normal} .ev i:before{content:" "}
  .ev.evx{color:var(--bad);background:#2a1316}
  .arr{color:var(--mut);padding:0 1px}
</style></head>
<body>
<header>
  <span class="dot" id="health"></span>
  <h1>Go-live simulator &middot; live monitor</h1>
  <span class="spacer"></span>
  <span class="muted" id="counts"></span>
  <span class="muted" id="updated">connecting&hellip;</span>
  <button onclick="tick()">Refresh</button>
</header>
<main>
  <div class="grid">
    <section>
      <h2>&#9201; Cron / scheduler</h2>
      <div class="kv">
        <span>schedule: <b class="mono" id="sched">&mdash;</b></span>
        <span>enabled: <b id="enabled">&mdash;</b></span>
        <span>last run: <b id="lastrun">&mdash;</b></span>
      </div>
      <div class="body">
        <div class="muted" style="margin-bottom:4px">Active campaigns the cron drives</div>
        <table><thead><tr><th>target</th><th>status</th><th>rate</th><th>tz</th><th>id</th></tr></thead><tbody id="actrows"></tbody></table>
        <div class="muted" style="margin:12px 0 4px">Recent hourly runs</div>
        <table><thead><tr><th>target</th><th>hr</th><th>kind</th><th>done</th><th>status</th><th>started</th></tr></thead><tbody id="runrows"></tbody></table>
      </div>
    </section>
    <section>
      <h2>&#127760; Incoming requests <span class="muted" id="reqsum"></span></h2>
      <div class="body">
        <table><thead><tr><th>time</th><th>method</th><th>path</th><th>ms</th><th>status</th></tr></thead><tbody id="reqrows"></tbody></table>
      </div>
    </section>
  </div>
  <section>
    <h2>&#128100; Visits &amp; events</h2>
    <div class="kv"><span class="muted">events funnel (ok/attempts, recent):</span> <span id="evsum"></span></div>
    <div class="body" id="visits" style="max-height:56vh"></div>
  </section>
</main>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const j=async u=>{const r=await fetch(u);if(!r.ok)throw new Error(u+' '+r.status);return r.json()};
const fmt=t=>{if(!t)return '—';return new Date(t).toLocaleTimeString()};
const ago=t=>{if(!t)return '';const s=Math.round((Date.now()-new Date(t).getTime())/1000);if(s<0)return '';if(s<60)return s+'s ago';if(s<3600)return Math.round(s/60)+'m ago';return Math.round(s/3600)+'h ago'};

async function loadCron(){
  const d=await j('/__monitor/api/cron');
  $('sched').textContent=d.schedule||'—';
  $('enabled').innerHTML=d.scheduler_enabled?'<span class=ok>yes</span>':'<span class=bad>no</span>';
  $('lastrun').innerHTML=d.lastRun?esc(new Date(d.lastRun.started_at).toLocaleString())+' <span class="muted">('+ago(d.lastRun.started_at)+')</span>':'<span class=muted>none yet</span>';
  $('counts').textContent=d.visits?((d.visits.total||0)+' visits · '+(d.visits.completed||0)+' ok · '+(d.visits.conversions||0)+' conv · '+(d.sites||0)+' campaigns'):'';
  $('actrows').innerHTML=(d.active||[]).map(s=>'<tr><td class="path">'+esc(s.url)+'</td><td class="ok">'+esc(s.status)+'</td><td>'+(s.daily_visits)+'/day</td><td class="mono">'+esc(s.timezone||'')+'</td><td class="muted mono">'+esc(String(s.id).slice(0,8))+'</td></tr>').join('')||'<tr><td colspan=5 class=muted>no active campaigns</td></tr>';
  $('runrows').innerHTML=(d.runs||[]).map(r=>'<tr><td class="path">'+esc(r.url||String(r.site_id).slice(0,8))+'</td><td>'+(r.hour)+'</td><td>'+esc(r.kind)+'</td><td>'+(r.completed)+'/'+(r.planned)+(r.failed?' <span class=bad>'+r.failed+'✗</span>':'')+'</td><td>'+esc(r.status)+'</td><td class="mono muted">'+fmt(r.started_at)+'</td></tr>').join('')||'<tr><td colspan=6 class=muted>no runs yet</td></tr>';
}
async function loadReqs(){
  const d=await j('/__monitor/api/requests');
  $('reqsum').innerHTML=(d.shown||0)+'/'+(d.total||0)+' '+esc(d.window||'')+' '+Object.entries(d.byStatus||{}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<span class="pill s'+String(k)[0]+'">'+v+'×'+esc(k)+'</span>').join('');
  $('reqrows').innerHTML=(d.requests||[]).map(r=>'<tr class="s'+String(r.s)[0]+'"><td class="mono muted">'+fmt(r.t)+'</td><td>'+esc(r.m)+'</td><td class="path">'+esc(r.p)+'</td><td class="mono muted">'+(r.ms==null?'':r.ms)+'</td><td class="mono">'+esc(r.s)+'</td></tr>').join('')||'<tr><td colspan=5 class=muted>no requests since restart</td></tr>';
}
async function loadVisits(){
  const d=await j('/__monitor/api/visits');
  $('evsum').innerHTML=Object.entries(d.events_summary||{}).sort((a,b)=>b[1].attempts-a[1].attempts).map(([k,o])=>'<span class="pill">'+esc(k)+' <b>'+o.ok+'</b>/'+o.attempts+'</span>').join('')||'<span class=muted>none</span>';
  $('visits').innerHTML=(d.visits||[]).map(v=>{
    const badges=[
      v.converting?'<span class="tag conv">converting</span>':'',
      v.conversion?'<span class="tag won">CONVERTED'+(v.type?(' · '+esc(v.type)):'')+'</span>':'',
      '<span class="tag '+(v.status=='completed'?'ok':(v.status=='failed'?'bad':'mut'))+'">'+esc(v.status)+'</span>'
    ].join(' ');
    const ev=(v.events||[]).map(e=>'<span class="ev'+(e.ok?'':' evx')+'">'+esc(e.action)+(e.detail?'<i>'+esc(e.detail)+'</i>':'')+'</span>').join('<span class="arr">→</span>')||'<span class=muted>no steps</span>';
    return '<div class="visit"><div class="vh"><span class="mono muted">'+fmt(v.started_at)+'</span> <b>'+esc(v.device||'')+'</b> <span class="path">'+esc(v.url||'')+'</span> '+badges+' <span class="muted">'+(v.pages)+'p · '+(v.sec==null?'?':v.sec)+'s · '+esc(v.proxy||'')+'</span></div>'+(v.entry?'<div class="vlanding muted mono">↳ '+esc(v.entry)+'</div>':'')+'<div class="evrow">'+ev+'</div></div>';
  }).join('')||'<div class=muted>no visits yet</div>';
}
async function tick(){
  let ok=true;
  try{await loadCron()}catch(e){ok=false}
  try{await loadReqs()}catch(e){ok=false}
  try{await loadVisits()}catch(e){ok=false}
  $('health').className='dot '+(ok?'on':'off');
  $('updated').textContent='updated '+new Date().toLocaleTimeString();
}
tick(); setInterval(tick,5000);
</script>
</body></html>`;
