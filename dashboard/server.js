'use strict';
/*
 * Local monitor dashboard for the live go-live simulator (DigitalOcean droplet).
 *
 * READ-ONLY. It SSHes to the droplet (using the existing deploy key) to read:
 *   - the API request log  -> docker logs (JSON `msg:"req"` lines)
 *   - the cron/scheduler state -> the `runs` table + scheduler log lines
 * Nothing is written to the live system. The server binds to 127.0.0.1 only.
 *
 *   Run:  node dashboard/server.js      then open  http://127.0.0.1:8090
 *   Env:  SIM_IP, SIM_SSH_KEY, SIM_CONTAINER, MONITOR_PORT (all optional)
 */
const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const IP        = process.env.SIM_IP || '164.90.179.41';
const KEY       = process.env.SIM_SSH_KEY || path.join(__dirname, '..', 'scripts', 'deploy', '.ssh', 'id_ed25519');
const CONTAINER = process.env.SIM_CONTAINER || 'ad-campaigns';
const PORT      = parseInt(process.env.MONITOR_PORT, 10) || 8090;
const SSH_OPTS  = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12'];

function ssh(remoteCmd) {
  return new Promise((resolve) => {
    const p = spawn('ssh', ['-i', KEY, ...SSH_OPTS, `root@${IP}`, remoteCmd], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.on('error', (e) => resolve({ code: -1, out, err: String((e && e.message) || e) }));
  });
}

// Run a JS snippet inside the app container against the prod DB (base64 to dodge quoting).
function sshNode(js) {
  const b64 = Buffer.from(js, 'utf8').toString('base64');
  return ssh(`echo ${b64} | base64 -d | docker exec -i ${CONTAINER} sh -c 'cat > /tmp/mq.js && NODE_PATH=/app/node_modules node /tmp/mq.js; rm -f /tmp/mq.js'`);
}

const DB_QUERY = `
const D=require("better-sqlite3");
const db=new D("/app/data/campaigns.db",{readonly:true});
const active=db.prepare("SELECT id,url,status,daily_visits,timezone,created_at FROM sites WHERE status='active' ORDER BY created_at DESC").all();
const runs=db.prepare("SELECT r.site_id,s.url url,r.hour,r.kind,r.planned,r.completed,r.failed,r.status,r.started_at,r.finished_at FROM runs r LEFT JOIN sites s ON s.id=r.site_id ORDER BY r.started_at DESC LIMIT 25").all();
const vc=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) completed,SUM(conversion) conversions,MAX(started_at) last FROM visits").get();
const sites=db.prepare("SELECT COUNT(*) n FROM sites").get().n;
console.log(JSON.stringify({active,runs,visits:vc,sites}));
db.close();
`;

const parseJsonLines = (s) => (s || '').split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const app = express();

// --- API request log on the live box ---
app.get('/api/requests', async (req, res) => {
  const r = await ssh(`docker logs --since 45m ${CONTAINER} 2>&1 | grep '"msg":"req"' | tail -150`);
  if (r.code !== 0 && !r.out) return res.status(502).json({ error: 'ssh/log read failed', detail: r.err.slice(0, 500) });
  const reqs = parseJsonLines(r.out).filter((j) => j.msg === 'req').map((j) => ({ t: j.t, m: j.m, p: j.p, s: j.s }));
  reqs.reverse(); // newest first
  const byStatus = {};
  for (const x of reqs) byStatus[x.s] = (byStatus[x.s] || 0) + 1;
  res.json({ window: '45m', count: reqs.length, byStatus, requests: reqs.slice(0, 120) });
});

// --- cron / scheduler state ---
app.get('/api/cron', async (req, res) => {
  const [db, tickLog, schedLog] = await Promise.all([
    sshNode(DB_QUERY),
    ssh(`docker logs --since 6h ${CONTAINER} 2>&1 | grep '"msg":"tick"' | tail -8`),
    ssh(`docker logs --since 12h ${CONTAINER} 2>&1 | grep '"mod":"scheduler"' | tail -30`),
  ]);
  let data = {};
  try { data = JSON.parse((db.out || '').trim().split('\n').pop()); }
  catch { data = { db_error: ((db.err || db.out) || '').slice(0, 400) }; }
  const ticks = parseJsonLines(tickLog.out);
  res.json({
    schedule: '0 * * * *  (top of every hour, UTC)',
    container: CONTAINER,
    host: IP,
    lastTick: ticks.length ? ticks[ticks.length - 1] : null,
    scheduler_events: parseJsonLines(schedLog.out).reverse().slice(0, 20),
    ...data,
  });
});

app.get('/', (req, res) => res.type('html').send(HTML));

app.listen(PORT, '127.0.0.1', () => console.log(`monitor -> http://127.0.0.1:${PORT}  (host ${IP}, container ${CONTAINER})`));

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulator monitor</title>
<style>
  :root{--bg:#0e1116;--card:#161b22;--line:#222b36;--fg:#e6edf3;--mut:#8b98a5;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--info:#58a6ff}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,Segoe UI,Roboto,Arial}
  header{display:flex;align-items:center;gap:12px;padding:12px 18px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
  header h1{font-size:15px;margin:0;font-weight:600}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--mut);display:inline-block}
  .dot.on{background:var(--ok);box-shadow:0 0 6px var(--ok)} .dot.off{background:var(--bad)}
  .spacer{flex:1}.muted{color:var(--mut)}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
  main{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px;align-items:start}
  @media(max-width:980px){main{grid-template-columns:1fr}}
  section{background:var(--card);border:1px solid var(--line);border-radius:9px;overflow:hidden}
  h2{font-size:13px;margin:0;padding:10px 12px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center}
  .body{padding:10px 12px;max-height:46vh;overflow:auto}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:var(--mut);font-weight:500;padding:4px 6px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card)}
  td{padding:4px 6px;border-bottom:1px solid #1b2230;vertical-align:top}
  .path{font-family:ui-monospace,monospace;word-break:break-all;color:#cdd9e5}
  tr.s2 td:last-child{color:var(--ok)} tr.s3 td:last-child{color:var(--info)} tr.s4 td:last-child{color:var(--warn)} tr.s5 td:last-child{color:var(--bad)}
  .pill{display:inline-block;padding:1px 7px;border-radius:10px;background:#1f2733;margin-left:6px;font-size:12px}
  .pill.s2{color:var(--ok)} .pill.s4{color:var(--warn)} .pill.s5{color:var(--bad)} .pill.s3{color:var(--info)}
  .bad{color:var(--bad)} .ok{color:var(--ok)}
  .logline{font-family:ui-monospace,monospace;font-size:12px;padding:2px 0;border-bottom:1px solid #1b2230;white-space:pre-wrap;word-break:break-word}
  .kv{display:flex;gap:18px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--line);font-size:12.5px}
  .kv b{font-weight:600}
  button{background:#1f2733;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
</style></head>
<body>
<header>
  <span class="dot" id="health"></span>
  <h1>Go-live simulator · live monitor</h1>
  <span class="muted mono" id="hostlabel"></span>
  <span class="spacer"></span>
  <span class="muted" id="counts"></span>
  <span class="muted" id="updated">connecting…</span>
  <button onclick="tick()">Refresh</button>
</header>
<main>
  <section>
    <h2>⏱ Cron / scheduler</h2>
    <div class="kv">
      <span>schedule: <b class="mono" id="sched">—</b></span>
      <span>last tick: <b id="lasttick">—</b></span>
    </div>
    <div class="body">
      <div class="muted" style="margin-bottom:4px">Active campaigns the cron drives</div>
      <table><thead><tr><th>target</th><th>status</th><th>rate</th><th>tz</th><th>id</th></tr></thead><tbody id="actrows"></tbody></table>
      <div class="muted" style="margin:12px 0 4px">Recent hourly runs</div>
      <table><thead><tr><th>target</th><th>hr</th><th>kind</th><th>done</th><th>status</th><th>started</th></tr></thead><tbody id="runrows"></tbody></table>
      <div class="muted" style="margin:12px 0 4px">Scheduler events</div>
      <div id="events"></div>
    </div>
  </section>
  <section>
    <h2>🌐 Incoming requests <span class="muted" id="reqsum"></span></h2>
    <div class="body">
      <table><thead><tr><th>time</th><th>method</th><th>path</th><th>status</th></tr></thead><tbody id="reqrows"></tbody></table>
    </div>
  </section>
</main>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const j=async u=>{const r=await fetch(u);if(!r.ok)throw new Error(u+' '+r.status);return r.json()};
const fmt=t=>{if(!t)return '—';const d=new Date(t);return d.toLocaleTimeString()};
const ago=t=>{if(!t)return '';const s=Math.round((Date.now()-new Date(t).getTime())/1000);if(s<0)return '';if(s<60)return s+'s ago';if(s<3600)return Math.round(s/60)+'m ago';return Math.round(s/3600)+'h ago'};
const omit=(o,k)=>{const r={};for(const x in o)if(!k.includes(x))r[x]=o[x];return r};

async function loadCron(){
  const d=await j('/api/cron');
  $('sched').textContent=d.schedule||'—';
  $('hostlabel').textContent=(d.host||'')+' · '+(d.container||'');
  $('lasttick').innerHTML=d.lastTick?esc(new Date(d.lastTick.t).toLocaleString())+' <span class="muted">('+ago(d.lastTick.t)+', '+(d.lastTick.activeSites)+' active)</span>':'<span class="muted">none in 6h</span>';
  $('counts').textContent=d.visits?((d.visits.total||0)+' visits · '+(d.visits.completed||0)+' ok · '+(d.visits.conversions||0)+' conv · '+(d.sites||0)+' campaigns'):'';
  $('actrows').innerHTML=(d.active||[]).map(s=>'<tr><td class="path">'+esc(s.url)+'</td><td class="ok">'+esc(s.status)+'</td><td>'+(s.daily_visits)+'/day</td><td class="mono">'+esc(s.timezone||'')+'</td><td class="muted mono">'+esc(String(s.id).slice(0,8))+'</td></tr>').join('')||'<tr><td colspan=5 class=muted>no active campaigns</td></tr>';
  $('runrows').innerHTML=(d.runs||[]).map(r=>'<tr><td class="path">'+esc(r.url||String(r.site_id).slice(0,8))+'</td><td>'+(r.hour)+'</td><td>'+esc(r.kind)+'</td><td>'+(r.completed)+'/'+(r.planned)+(r.failed?' <span class=bad>'+r.failed+'✗</span>':'')+'</td><td>'+esc(r.status)+'</td><td class="mono muted">'+fmt(r.started_at)+'</td></tr>').join('')||'<tr><td colspan=6 class=muted>no runs yet</td></tr>';
  $('events').innerHTML=(d.scheduler_events||[]).map(e=>'<div class="logline"><span class="muted">'+fmt(e.t)+'</span> '+esc(e.msg)+' <span class="muted">'+esc(JSON.stringify(omit(e,['t','level','msg','mod'])))+'</span></div>').join('')||'<div class="muted">no scheduler events in 12h</div>';
  return true;
}
async function loadReqs(){
  const d=await j('/api/requests');
  $('reqsum').innerHTML=(d.count||0)+' in '+esc(d.window)+' '+Object.entries(d.byStatus||{}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>'<span class="pill s'+String(k)[0]+'">'+v+'×'+esc(k)+'</span>').join('');
  $('reqrows').innerHTML=(d.requests||[]).map(r=>'<tr class="s'+String(r.s)[0]+'"><td class="mono muted">'+fmt(r.t)+'</td><td>'+esc(r.m)+'</td><td class="path">'+esc(r.p)+'</td><td class="mono">'+esc(r.s)+'</td></tr>').join('')||'<tr><td colspan=4 class=muted>no requests in window</td></tr>';
  return true;
}
async function tick(){
  let ok=true;
  try{await loadCron()}catch(e){ok=false}
  try{await loadReqs()}catch(e){ok=false}
  $('health').className='dot '+(ok?'on':'off');
  $('updated').textContent='updated '+new Date().toLocaleTimeString();
}
tick(); setInterval(tick,5000);
</script>
</body></html>`;
