'use strict';
/*
 * One-shot deploy:  node scripts/deploy/deploy.js [--dry-run]
 *
 *  1. Validate DigitalOcean + Cloudflare tokens.
 *  2. Ensure an SSH key (generated under scripts/deploy/.ssh) is registered on DigitalOcean.
 *  3. Create an Ubuntu droplet that installs Docker via cloud-init.
 *  4. Upload the project, write a production .env, and `docker compose -f docker-compose.prod.yml up -d --build`.
 *  5. Point DEPLOY_DOMAIN (service.layout.ai) at the droplet via a Cloudflare A record (DNS-only, so Caddy can get a cert).
 *  6. Poll https://DEPLOY_DOMAIN/health.
 *
 * Requires valid DIGITALOCEAN_TOKEN and CF_API_TOKEN (DNS edit + zone read) in .env.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const config = require('../../src/config');

const DRY = process.argv.includes('--dry-run');
const FORCE_WRITE_ENV = process.argv.includes('--write-env'); // rewrite remote .env (rotate API_KEY / change DEPLOY_DOMAIN)
const ROOT = path.join(__dirname, '..', '..');
const SSH_DIR = path.join(__dirname, '.ssh');
const KEY_PATH = path.join(SSH_DIR, 'id_ed25519');
const DOMAIN = config.deploy.domain;
const ROOT_DOMAIN = DOMAIN.split('.').slice(-2).join('.');

const log = (...a) => console.log('[deploy]', ...a);
const die = (m) => { console.error('[deploy] ERROR:', m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doApi(p, method = 'GET', body) {
  const r = await fetch(`https://api.digitalocean.com/v2${p}`, {
    method,
    headers: { Authorization: `Bearer ${config.digitalOcean.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, json };
}

async function cfApi(p, method = 'GET', body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, {
    method,
    headers: { Authorization: `Bearer ${config.cloudflare.dnsToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

const SSH_OPTS = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12'];

function ssh(ip, command) {
  return sh('ssh', ['-i', KEY_PATH, ...SSH_OPTS, `root@${ip}`, command]);
}

function ensureSshKey() {
  if (!fs.existsSync(SSH_DIR)) fs.mkdirSync(SSH_DIR, { recursive: true });
  if (!fs.existsSync(KEY_PATH)) {
    log('generating SSH keypair');
    const r = sh('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', KEY_PATH, '-C', 'golive-simulator-deploy']);
    if (r.status !== 0) die(`ssh-keygen failed: ${r.stderr || r.stdout}`);
  }
  return fs.readFileSync(`${KEY_PATH}.pub`, 'utf8').trim();
}

async function ensureDoSshKey(pubKey) {
  const list = await doApi('/account/keys?per_page=200');
  const existing = (list.json.ssh_keys || []).find((k) => k.public_key.split(' ').slice(0, 2).join(' ') === pubKey.split(' ').slice(0, 2).join(' '));
  if (existing) { log('reusing DO ssh key', existing.id); return existing.fingerprint; }
  const created = await doApi('/account/keys', 'POST', { name: `golive-simulator-${Date.now()}`, public_key: pubKey });
  if (created.status >= 300) die(`upload ssh key failed: ${JSON.stringify(created.json)}`);
  log('uploaded ssh key', created.json.ssh_key.id);
  return created.json.ssh_key.fingerprint;
}

async function createDroplet(fingerprint) {
  const userData = fs.readFileSync(path.join(__dirname, 'cloud-init.sh'), 'utf8');
  const body = {
    name: 'golive-simulator',
    region: config.deploy.region,
    size: config.deploy.size,
    image: config.deploy.image,
    ssh_keys: [fingerprint],
    user_data: userData,
    tags: ['golive-simulator'],
    monitoring: true,
  };
  const res = await doApi('/droplets', 'POST', body);
  if (res.status >= 300) die(`droplet create failed: ${JSON.stringify(res.json)}`);
  const id = res.json.droplet.id;
  log('droplet creating', id);
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const d = await doApi(`/droplets/${id}`);
    const drop = d.json.droplet;
    const ip = (drop.networks.v4.find((n) => n.type === 'public') || {}).ip_address;
    if (drop.status === 'active' && ip) { log('droplet active', ip); return { id, ip }; }
  }
  die('droplet did not become active in time');
}

async function waitForSsh(ip) {
  for (let i = 0; i < 40; i++) {
    const r = ssh(ip, 'echo ok');
    if (r.status === 0 && /ok/.test(r.stdout)) { log('ssh up'); return; }
    await sleep(6000);
  }
  die('ssh never came up');
}

async function waitForDocker(ip) {
  for (let i = 0; i < 40; i++) {
    const r = ssh(ip, 'command -v docker && docker compose version >/dev/null 2>&1 && echo ready');
    if (/ready/.test(r.stdout)) { log('docker ready'); return; }
    await sleep(8000);
  }
  die('docker not ready in time (cloud-init still running?)');
}

function makeTarball() {
  const out = path.join(ROOT, 'project.tgz');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  // List explicit paths (broad --exclude=data also matches src/data and drops files).
  const r = sh('tar', ['czf', out, '--exclude=id_ed25519*', '--exclude=scripts/deploy/.ssh',
    'package.json', 'package-lock.json', 'Dockerfile',
    'docker-compose.yml', 'docker-compose.prod.yml', 'Caddyfile',
    'src', 'scripts'], { cwd: ROOT });
  if (r.status !== 0) die(`tar failed: ${r.stderr}`);
  return out;
}

function buildRemoteEnv(apiKey) {
  const lines = [
    'PORT=8080',
    `API_KEY=${apiKey}`,
    'LOG_LEVEL=info',
    'TZ=UTC',
    'DATABASE_PATH=/app/data/campaigns.db',
    `DEPLOY_DOMAIN=${DOMAIN}`,
    '',
    `CF_ACCOUNT_ID=${config.cloudflare.accountId}`,
    `CF_API_TOKEN=${config.cloudflare.apiToken}`,
    `GEMINI_API_KEY=${config.gemini.apiKey}`,
    `GEMINI_MODEL=${config.gemini.model}`,
    '',
    `PROXY_ENABLED=${config.proxy.enabled}`,
    `PROXY_SERVER=${config.proxy.server}`,
    `PROXY_USERNAME=${config.proxy.username}`,
    `PROXY_PASSWORD=${config.proxy.password}`,
    `PROXY_LIST=${config.proxy.list.join(',')}`,
    `PROXY_ROTATE_MINUTES=${config.proxy.rotateMinutes}`,
    `PROXY_SESSION_PARAM=${config.proxy.sessionParam}`,
    '',
    `DAILY_VISITS=${config.sim.dailyVisits}`,
    `CONVERTING_VISITS=${config.sim.convertingVisits}`,
    `REFERER_BASE=${config.sim.refererBase}`,
    `APPEND_UTM=${config.sim.appendUtm}`,
    `SUBMIT_FORMS=${config.sim.submitForms}`,
    `COMPLETE_PAYMENT=${config.sim.completePayment}`,
    `EMAIL_DOMAINS=${config.sim.emailDomains.join(',')}`,
    `MAX_CONCURRENT_VISITS=${config.sim.maxConcurrentVisits}`,
    'HEADLESS=true',
    'SCHEDULER_ENABLED=true',
  ];
  return lines.join('\n') + '\n';
}

async function findExistingDroplet() {
  const r = await doApi('/droplets?tag_name=golive-simulator');
  for (const d of (r.json.droplets || [])) {
    const pub = ((d.networks && d.networks.v4) || []).find((n) => n.type === 'public');
    if (pub) return { id: d.id, ip: pub.ip_address };
  }
  return null;
}

function readRemoteApiKey(ip) {
  const r = ssh(ip, "grep '^API_KEY=' /opt/simulator/.env | head -n1 | cut -d= -f2-");
  return (r.stdout || '').trim();
}

async function deployToDroplet(ip, { apiKey, writeEnv }) {
  const tgz = makeTarball();
  log('uploading project');
  let r = sh('scp', ['-i', KEY_PATH, ...SSH_OPTS, tgz, `root@${ip}:/root/project.tgz`]);
  if (r.status !== 0) die(`scp failed: ${r.stderr}`);
  // Replace code (rm src so renamed/removed files don't linger) but PRESERVE the existing .env.
  ssh(ip, 'mkdir -p /opt/simulator && rm -rf /opt/simulator/src && tar xzf /root/project.tgz -C /opt/simulator');

  if (writeEnv) {
    const env = buildRemoteEnv(apiKey);
    r = sh('ssh', ['-i', KEY_PATH, ...SSH_OPTS, `root@${ip}`, 'cat > /opt/simulator/.env'], { input: env });
    if (r.status !== 0) die(`writing remote .env failed: ${r.stderr}`);
    log('wrote production .env');
  } else {
    log('preserving existing /opt/simulator/.env (API_KEY + proxy config kept)');
  }

  log('building & starting containers (this takes a few minutes)');
  r = ssh(ip, 'cd /opt/simulator && docker compose -f docker-compose.prod.yml up -d --build --remove-orphans 2>&1 | tail -n 30');
  log(r.stdout || r.stderr);
}

async function configureDns(ip) {
  const zones = await cfApi(`/zones?name=${ROOT_DOMAIN}`);
  const zone = (zones.json.result || [])[0];
  if (!zone) die(`Cloudflare zone for ${ROOT_DOMAIN} not found on this account`);
  log('cf zone', zone.id);
  const existing = await cfApi(`/zones/${zone.id}/dns_records?type=A&name=${DOMAIN}`);
  const rec = (existing.json.result || [])[0];
  const payload = { type: 'A', name: DOMAIN, content: ip, ttl: 120, proxied: false };
  const res = rec
    ? await cfApi(`/zones/${zone.id}/dns_records/${rec.id}`, 'PUT', payload)
    : await cfApi(`/zones/${zone.id}/dns_records`, 'POST', payload);
  if (!res.json.success) die(`DNS update failed: ${JSON.stringify(res.json.errors)}`);
  log(`DNS ${rec ? 'updated' : 'created'}: ${DOMAIN} -> ${ip} (proxied=false)`);
}

async function verify() {
  for (let i = 0; i < 30; i++) {
    await sleep(10000);
    try {
      const r = await fetch(`https://${DOMAIN}/health`);
      if (r.ok) { log('LIVE: https://' + DOMAIN + '/health ->', (await r.json()).status); return true; }
    } catch { /* cert/dns still propagating */ }
    log('waiting for https://' + DOMAIN + ' ...');
  }
  log('NOTE: could not confirm https yet (DNS/cert may still be propagating). Check manually.');
  return false;
}

(async () => {
  log(`target domain: ${DOMAIN} (root zone ${ROOT_DOMAIN})`);
  if (!config.digitalOcean.token) die('DIGITALOCEAN_TOKEN missing');
  if (!config.cloudflare.apiToken) die('CF_API_TOKEN missing');

  const acct = await doApi('/account');
  if (acct.status !== 200) die(`DigitalOcean auth failed (${acct.status}): ${JSON.stringify(acct.json)}`);
  log('DO account ok:', acct.json.account && acct.json.account.email);

  // Validate Cloudflare via the zone lookup itself (scoped tokens often can't hit /user/tokens/verify).
  const zones = await cfApi(`/zones?name=${ROOT_DOMAIN}`);
  if (zones.json.success === false) die(`Cloudflare token cannot read zones: ${JSON.stringify(zones.json.errors)} (needs Zone:Read + DNS:Edit on ${ROOT_DOMAIN}; set CF_DNS_TOKEN if the crawl token lacks DNS perms)`);
  if (!((zones.json.result || [])[0])) die(`Cloudflare has no zone for ${ROOT_DOMAIN}; add the domain to this account first`);
  log('CF zone present for', ROOT_DOMAIN);

  if (DRY) { log('dry-run OK: credentials valid and zone present. Stopping before creating resources.'); process.exit(0); }

  const existing = await findExistingDroplet();
  let ip; let apiKey; let fresh;
  if (existing) {
    ip = existing.ip; fresh = false;
    log(`reusing existing droplet ${existing.id} (${ip}) — updating in place`);
  } else {
    fresh = true;
    apiKey = crypto.randomBytes(24).toString('hex');
    const pub = ensureSshKey();
    const fingerprint = await ensureDoSshKey(pub);
    ({ ip } = await createDroplet(fingerprint));
  }
  await configureDns(ip);          // ensure DNS -> droplet (lets Caddy pass ACME on fresh installs)
  await waitForSsh(ip);
  await waitForDocker(ip);
  if (FORCE_WRITE_ENV && !fresh) apiKey = config.apiKey || crypto.randomBytes(24).toString('hex');
  await deployToDroplet(ip, { apiKey, writeEnv: fresh || FORCE_WRITE_ENV });
  if (!fresh && !FORCE_WRITE_ENV) apiKey = readRemoteApiKey(ip) || '(unchanged — kept in existing .env)';
  await verify();

  console.log('\n========================================');
  console.log(' Deploy summary');
  console.log('  Droplet IP :', ip);
  console.log('  URL        : https://' + DOMAIN);
  console.log('  API_KEY    :', apiKey, '(store this — required for management endpoints)');
  console.log('  Example    : curl -s -X POST https://' + DOMAIN + '/api/sites -H "Authorization: Bearer ' + apiKey + '" -H "Content-Type: application/json" -d \'{"url":"https://customer.com","customer":{"name":"Acme"}}\'');
  console.log('========================================');
  process.exit(0);
})().catch((e) => die(e.stack || e.message));
