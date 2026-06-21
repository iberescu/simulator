'use strict';
/*
 * On-demand runner (handy for an external cron or manual testing).
 *   node src/scripts/run-once.js --site <campaignId> [--count N] [--convert]
 *   node src/scripts/run-once.js --url <url> [--count N] [--convert]
 *   node src/scripts/run-once.js --tick        # run one hourly tick for all active campaigns
 */
const db = require('../db');
const scheduler = require('../scheduler/cron');
const { crawlSite } = require('../crawl/cloudflare');
const { generateStrategies } = require('../ai/gemini');
const { runVisit } = require('../sim/runner');
const { closeBrowser } = require('../sim/browser');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i < 0) return def;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

(async () => {
  db.migrate();
  const siteId = arg('--site');
  const url = arg('--url');
  const count = parseInt(arg('--count', '3'), 10) || 3;
  const convert = process.argv.includes('--convert');

  if (process.argv.includes('--tick')) {
    await scheduler.tick({ catchUp: true });
    console.log('tick dispatched (visits run in background within the hour)');
    return;
  }

  if (siteId && siteId !== true) {
    const results = await scheduler.runNow(siteId, { count, converting: convert ? true : undefined });
    console.log(JSON.stringify(results.map((r) => ({ ok: r.ok, cid: r.cid, error: r.error })), null, 2));
  } else if (url && url !== true) {
    const crawl = await crawlSite(url);
    const strat = await generateStrategies({ url }, crawl);
    const site = { id: `once-${Date.now()}`, url };
    const out = [];
    for (let i = 0; i < count; i++) {
      const conv = convert || i === 0;
      const pool = strat.data.filter((s) => !!s.converting === !!conv);
      const use = pool.length ? pool : strat.data;
      const strategy = use[Math.floor(Math.random() * use.length)];
      out.push(await runVisit({ site, strategy, links: crawl.links, runId: null }));
    }
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.error('usage: --site <id> [--count N] [--convert] | --url <url> [--count N] | --tick');
    process.exit(1);
  }

  await closeBrowser();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
