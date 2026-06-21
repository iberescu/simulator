'use strict';
// Manual single-visit harness:  node src/scripts/test-visit.js <url> [--convert]
const db = require('../db');
const { crawlSite } = require('../crawl/cloudflare');
const { generateStrategies } = require('../ai/gemini');
const { runVisit } = require('../sim/runner');
const { closeBrowser } = require('../sim/browser');

(async () => {
  db.migrate();
  const url = process.argv[2] || 'https://quotes.toscrape.com/';
  const wantConvert = process.argv.includes('--convert');

  console.log(`\n# Crawling ${url} ...`);
  const crawl = await crawlSite(url);
  console.log(`  source=${crawl.source} ecommerce=${crawl.isEcommerce} links=${crawl.links.length}`);

  console.log('# Generating strategies ...');
  const strat = await generateStrategies({ url }, crawl);
  console.log(`  source=${strat.source} count=${strat.data.length}`);

  const strategy = strat.data.find((s) => s.converting === wantConvert) || strat.data[0];
  console.log(`# Running visit: "${strategy.persona}" converting=${strategy.converting} device=${strategy.device} steps=${strategy.steps.length}`);

  const site = { id: `test-${Date.now()}`, url };
  const res = await runVisit({ site, strategy, links: crawl.links, runId: null });

  const v = db.listVisits(site.id, 1)[0];
  console.log('\n# Result:');
  console.log(JSON.stringify({
    ok: res.ok,
    cid: v.cid,
    status: v.status,
    pages_visited: v.pages_visited,
    duration_ms: v.duration_ms,
    referer: v.referer,
    entry_url: v.entry_url,
    persona: v.persona,
    identity_email: v.identity_email,
    actions: JSON.parse(v.actions),
    error: v.error,
  }, null, 2));

  await closeBrowser();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
