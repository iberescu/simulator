'use strict';
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;

function emit(level, msg, extra) {
  if (LEVELS[level] < current) return;
  let rec;
  try {
    rec = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra || {}) });
  } catch {
    rec = JSON.stringify({ t: new Date().toISOString(), level, msg });
  }
  if (level === 'error' || level === 'warn') process.stderr.write(rec + '\n');
  else process.stdout.write(rec + '\n');
}

function make(ctx) {
  return {
    debug: (m, e) => emit('debug', m, { ...ctx, ...e }),
    info: (m, e) => emit('info', m, { ...ctx, ...e }),
    warn: (m, e) => emit('warn', m, { ...ctx, ...e }),
    error: (m, e) => emit('error', m, { ...ctx, ...e }),
    child: (more) => make({ ...ctx, ...more }),
  };
}

module.exports = make({});
