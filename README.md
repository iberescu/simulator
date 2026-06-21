# Go-Live Traffic Simulator

Simulate realistic, human-like organic visitors on a website **before go-live**, so customers can
validate analytics, funnels and conversion tracking. A customer submits a URL + their details to the
API; the service then, every hour, crawls the site, asks **Gemini 2.5-flash** to design realistic
visitor behaviours, and drives a real **Chromium** browser (humanized mouse/scroll/typing, rotating
proxies, rotating user-agents) to perform those behaviours — ~20 visits/day per site, of which 4–5 are
high-intent "converting" visits (add-to-cart/checkout for shops, contact/quote forms otherwise). It
keeps running every day until a **stop** API call is received.

All simulated traffic is **identifiable**: the referer is always `ads.layout.ai` carrying a unique
`sim_id`, and the same `sim_id` + `utm_*` params are appended to the landing URL, so the customer can
filter the simulated traffic in their analytics.

```
   customer ──POST /api/sites──▶  API (Express + SQLite)
                                     │  creates site, starts simulation
                                     ▼
   hourly scheduler ──per active site──▶  pipeline:
        ① Cloudflare Browser-Rendering crawl (5–10 links + page content)   [fallback: direct fetch]
        ② Gemini 2.5-flash  ──▶  5–10 behaviour strategies (ecommerce-aware)
        ③ Playwright + stealth visit:
              rotating proxy ·  rotating UA ·  human mouse/scroll/typing
              referer = ads.layout.ai/?sim_id=… ·  realistic US persona for forms/checkout
                                     │
                                     ▼
   customer ──GET /api/sites/:id/visits──▶  log of sim_id / referer / persona for analytics matching
```

---

## Live deployment

Deployed and smoke-tested end-to-end on 2026-06-08:

- **URL:** https://service.layout.ai  (Caddy + Let's Encrypt TLS)
- **Droplet:** DigitalOcean `164.90.179.41` (`s-2vcpu-4gb`, `fra1`, Ubuntu 24.04)
- **Cloudflare crawl:** working (Browser-Rendering token `CF_API_TOKEN`).
- **DNS:** `service.layout.ai` A record (DNS-only / grey cloud) via `CF_DNS_TOKEN`.
- **Gemini 2.5-flash:** working.
- **Auth:** enabled in production — management endpoints require `Authorization: Bearer <API_KEY>`
  (generated during deploy and printed by `deploy.js`).

Verified flow on the live host: `create site → converting visit (add-to-cart → checkout) → visit log → stop`.

To manage the droplet: `ssh -i scripts/deploy/.ssh/id_ed25519 root@164.90.179.41`, then
`cd /opt/simulator && docker compose -f docker-compose.prod.yml ps|logs|up -d --build`.

---

## Quick start

### With Docker (recommended)
```bash
cp .env.example .env      # fill in GEMINI_API_KEY (CF_* optional for crawl)
docker compose up -d --build
curl localhost:8080/health
```

### With Node directly
```bash
npm install
npx playwright install chromium          # only needed when NOT using Docker
node src/index.js
```

### Try it
```bash
# create a site -> starts the daily simulation
curl -s -X POST localhost:8080/api/sites -H 'Content-Type: application/json' -d '{
  "url": "https://your-customer-site.com",
  "customer": { "name": "Acme Inc", "email": "ops@acme.com", "company": "Acme" }
}'

# run a few visits right now (don\'t wait for the hourly schedule)
curl -s -X POST localhost:8080/api/sites/<id>/simulate -H 'Content-Type: application/json' -d '{"count":3}'

# see the simulated visits (sim_id / referer / persona) for analytics cross-reference
curl -s "localhost:8080/api/sites/<id>/visits?token=<site_token>"

# stop the simulation for that customer
curl -s -X POST localhost:8080/api/sites/<id>/stop
```

You can also run visits from the CLI:
```bash
node src/scripts/simulate-once.js --url https://example.com --count 3   # ad-hoc, no DB site
node src/scripts/simulate-once.js --site <id> --count 5 --convert       # against a stored site
node src/scripts/test-visit.js  https://shop.example.com --convert      # single annotated visit
```

---

## API reference

Auth: if `API_KEY` is set, management endpoints require `Authorization: Bearer <API_KEY>`.
Read endpoints for one site also accept its `site_token` (header `X-Site-Token` or `?token=`).
If `API_KEY` is empty the API is open (dev only).

| Method & path | Purpose |
|---|---|
| `GET /health` | Health check. |
| `POST /api/sites` | Create a site and **start** the simulation. Body: `{ url, customer:{name,email,company}, daily_visits?, converting_visits?, notes? }`. Returns `id` + `site_token`. |
| `GET /api/sites` | List all sites (management). |
| `GET /api/sites/:id` | Site status + summary + recent visits. |
| `POST /api/sites/:id/stop` | **Stop** the simulation. |
| `POST /api/sites/:id/start` | Resume a stopped simulation. |
| `PATCH /api/sites/:id` | Update `daily_visits` / `converting_visits` / `notes`. |
| `POST /api/sites/:id/simulate` | Run `count` visits now. Body: `{ count?, converting? }`. |
| `GET /api/sites/:id/visits` | Visit log: `sim_id`, `referer`, `converting`, `persona`, `identity_email`, device, actions, timing. |
| `GET /api/sites/:id/runs` | Hourly run history. |
| `GET /api/sites/:id/strategies` | Latest AI-generated behaviour strategies. |

---

## How traffic is shaped

- **~20 visits/day per site** (`DAILY_VISITS`), spread across the day on a realistic diurnal curve
  (quiet overnight, busy midday/evening), each at a random minute within its hour.
- **4–5 converting visits/day** (`CONVERTING_VISITS`, randomised 4–5). Converting visits do the
  high-intent actions: ecommerce → `add_to_cart → view_cart → checkout`; non-ecommerce → contact /
  quote / price-inquiry **form fills**.
- Runs **every day until stopped**. A new plan is generated per day; strategies are refreshed every
  `STRATEGY_TTL_HOURS` (24h) from a fresh crawl.
- **Referer** is always `https://ads.layout.ai/?sim_id=<unique>&src=golive-simulator`, and the landing
  URL gets `utm_source=ads.layout.ai&utm_medium=simulator&utm_campaign=golive&sim_id=<unique>` so the
  customer can attribute/filter the traffic.

### Realistic personas & safety choices
- A pool of **35 fictional US personas** (`src/data/personas.js`) — real, valid city/state/ZIP combos and
  metro-correct area codes, fictional street numbers — fills checkout/billing and contact forms.
- **Name-matched emails** (e.g. `james.carter47@…`) are generated on a **controlled domain**
  (`EMAIL_DOMAINS`, default `layout.ai`). This keeps them realistic while ensuring form/checkout
  confirmation emails never reach an uninvolved third party. Point `EMAIL_DOMAINS` at your own
  test/catch-all domain to receive them.
- Phone numbers use the reserved `555-01XX` fictional block, so no real phone is ever contacted.
- **No real payments**: card fields are never filled and the final "Place order"/"Pay" button is never
  clicked (`COMPLETE_PAYMENT=false`). Checkout is exercised up to, but not through, payment.

---

## Rotating proxy

To enable a rotating residential/datacenter proxy, set in `.env`. The active production config
uses **Oxylabs residential, USA only, with a fresh sticky IP per browsing session**:

```bash
PROXY_ENABLED=true
PROXY_SERVER=http://pr.oxylabs.io:7777
PROXY_USERNAME=customer-<user>   # the rotator appends -cc-US-sessid-<id>-sesstime-3
PROXY_PASSWORD=secret
PROXY_SESSION_PARAM=sessid       # provider sticky-session keyword
PROXY_COUNTRY=US                 # exit country (-cc-US)
PROXY_SESSION_MINUTES=3          # Oxylabs `sesstime`: how long one IP is held
PROXY_PER_SESSION=true           # one sticky IP per visit (fresh IP next session)
PROXY_ROTATE_MINUTES=3           # time-bucket interval when PROXY_PER_SESSION=false

# …or a list of full proxy URLs, rotated by time bucket:
PROXY_LIST=http://user:pass@host1:port,http://user:pass@host2:port
```

Each visit seeds its `sessid` from the visit id, so one browsing session keeps one US residential
IP for the whole session; the next session gets a new IP. Combined with a randomised 2–3 min session
length (`SESSION_MIN_SECONDS`/`SESSION_MAX_SECONDS`), the exit IP effectively rotates ~every 3 minutes.
Also works with Bright Data, Decodo/Smartproxy, IPRoyal, etc.

---

## Configuration (`.env`)

| Key | Default | Notes |
|---|---|---|
| `PORT` | `8080` | API port. |
| `API_KEY` | _(empty)_ | Bearer token for management endpoints. Empty = open (dev). |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `gemini-2.5-flash` | Strategy synthesis. |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` | — | Cloudflare Browser-Rendering crawl + DNS. Falls back to direct fetch if absent/invalid. |
| `DIGITALOCEAN_TOKEN` | — | Deploy only. |
| `PROXY_ENABLED` / `PROXY_SERVER` | `false` / — | Enable proxying; residential endpoint (e.g. `http://pr.oxylabs.io:7777`). |
| `PROXY_USERNAME` / `PROXY_PASSWORD` | — | Provider credentials; username is the base (`customer-<user>`). |
| `PROXY_COUNTRY` | _(empty)_ | Exit country, appended as `-cc-<COUNTRY>` (e.g. `US`). |
| `PROXY_SESSION_PARAM` / `PROXY_SESSION_MINUTES` | — / `0` | Sticky-session keyword (`sessid`) and `sesstime` minutes. |
| `PROXY_PER_SESSION` | `false` | `true` = fresh sticky IP per visit; `false` = time-bucketed by `PROXY_ROTATE_MINUTES`. |
| `SESSION_MIN_SECONDS` / `SESSION_MAX_SECONDS` | `120` / `180` | Random per-visit dwell window (one IP per session). |
| `DAILY_VISITS` | `20` | Visits/day per site. |
| `CONVERTING_VISITS` | `5` | Converting visits/day (randomised 4–5). |
| `REFERER_BASE` | `https://ads.layout.ai` | Referer host. |
| `APPEND_UTM` | `true` | Append `utm_*` + `sim_id` to landing URL. |
| `SUBMIT_FORMS` | `true` | Submit contact/quote forms (test data). |
| `COMPLETE_PAYMENT` | `false` | Never enter card / place order when false. |
| `EMAIL_DOMAINS` | `layout.ai` | Controlled domain(s) for persona emails. |
| `MAX_CONCURRENT_VISITS` | `2` | Parallel browser visits. |
| `HEADLESS` | `true` | Headless Chromium. |
| `STRATEGY_TTL_HOURS` | `24` | Re-crawl + re-generate cadence. |
| `SCHEDULER_ENABLED` | `true` | Set false to run API only. |
| `PROXY_*` | see above | Rotating proxy. |
| `DEPLOY_DOMAIN` / `DEPLOY_REGION` / `DEPLOY_SIZE` / `DEPLOY_IMAGE` | `service.layout.ai` / `fra1` / `s-2vcpu-4gb` / `ubuntu-24-04-x64` | Deploy target. |

---

## Deploy

Requires **valid** `DIGITALOCEAN_TOKEN` and `CF_API_TOKEN` (Zone:Read + DNS:Edit on the `layout.ai`
zone, which must already exist in the Cloudflare account).

```bash
node scripts/deploy/deploy.js --dry-run     # validates tokens + that the layout.ai zone exists
node scripts/deploy/deploy.js               # full deploy
```

The deploy script:
1. Validates both tokens (aborts with a clear message if invalid — the current case).
2. Registers an SSH key (generated under `scripts/deploy/.ssh/`) on DigitalOcean.
3. Creates an Ubuntu droplet that installs Docker via `cloud-init.sh`.
4. Uploads the project, writes a production `.env` (with a generated `API_KEY`), and runs
   `docker compose -f docker-compose.prod.yml up -d --build` (app + **Caddy** for automatic HTTPS).
5. Creates/updates a **Cloudflare A record** `service.layout.ai → droplet IP` (DNS-only/grey-cloud so
   Caddy can complete the Let's Encrypt HTTP-01 challenge).
6. Polls `https://service.layout.ai/health` and prints the IP + generated `API_KEY`.

**Manual runbook** (if you prefer to deploy by hand): create the droplet, `scp` the repo to
`/opt/simulator`, create `.env`, `docker compose -f docker-compose.prod.yml up -d --build`, then add the
Cloudflare A record (grey cloud). Caddy obtains the TLS cert automatically.

> Once HTTPS is confirmed you may switch the Cloudflare record to proxied (orange cloud) with SSL mode
> **Full (strict)** — Caddy already serves a valid origin cert.

---

## Project structure
```
src/
  index.js              entrypoint (API + scheduler, graceful shutdown)
  config.js             env-driven config
  db.js                 SQLite schema + data access
  api/server.js         Express API
  crawl/cloudflare.js   Cloudflare Browser-Rendering crawl (+ direct-fetch fallback)
  ai/gemini.js          Gemini 2.5-flash -> behaviour strategies (+ heuristic fallback)
  proxy/rotator.js      rotating-proxy resolver
  sim/
    browser.js          Playwright + stealth launcher
    behaviors.js        behaviour engine (browse / search / add-to-cart / checkout / forms)
    humanize.js         human mouse paths, scrolling, typing
    useragents.js       Chromium-family UA pool
    runner.js           one visit: UA + proxy + persona + referer + execute + persist
  scheduler/cron.js     hourly tick, daily plan (20/day, 4–5 converting), until stopped
  data/personas.js      35 fictional US personas + inquiries
  scripts/              simulate-once.js, test-visit.js
scripts/
  preflight.js          credential/API checks
  deploy/deploy.js      DigitalOcean droplet + Cloudflare DNS deploy
Dockerfile · docker-compose.yml · docker-compose.prod.yml · Caddyfile
```

## Notes & limits
- The behaviour engine is heuristic: it fires real funnel/analytics events reliably, but exact element
  matching varies by site theme. Failures per step are logged and never abort the visit.
- SQLite is single-node (fine for this workload). The DB lives on the `sim-data` Docker volume.
- Only public http(s) targets are accepted; localhost/private/metadata IPs are rejected.
