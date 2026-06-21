'use strict';
const config = require('./config');
const log = require('./logger');
const db = require('./db');
const { createApp } = require('./api/server');
const scheduler = require('./scheduler/cron');
const { closeBrowser } = require('./sim/browser');

async function main() {
  db.migrate();
  const app = createApp();
  const server = app.listen(config.port, () => log.info('api listening', { port: config.port }));

  if (config.schedulerEnabled) scheduler.start();
  else log.warn('scheduler disabled (SCHEDULER_ENABLED=false)');

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { sig });
    scheduler.stop();
    server.close();
    await closeBrowser();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', { err: String((e && e.message) || e) }));
  process.on('uncaughtException', (e) => log.error('uncaughtException', { err: e.message, stack: e.stack }));
}

main().catch((e) => { log.error('fatal', { err: e.message, stack: e.stack }); process.exit(1); });
