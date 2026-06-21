'use strict';
const config = require('./../config');
const log = require('./../logger').child({ mod: 'proxy' });

/*
 * Rotating-proxy resolver.
 *  - Mode A (single endpoint): one PROXY_SERVER with optional sticky-session injection.
 *      A new "session" id is derived every PROXY_ROTATE_MINUTES; if PROXY_SESSION_PARAM is set
 *      it is appended to the username as `-<param>-<session>` (the convention used by most
 *      residential providers: e.g. user-session-abc123). This rotates the exit IP on schedule.
 *  - Mode B (list): PROXY_LIST of full proxy URLs, rotated by the same time bucket.
 *  - Disabled: returns null -> Playwright connects directly. (Fine for local testing.)
 */
class ProxyRotator {
  constructor(cfg = config.proxy) {
    this.cfg = cfg;
  }

  enabled() {
    return !!(this.cfg.enabled && (this.cfg.server || (this.cfg.list && this.cfg.list.length)));
  }

  bucket(now = Date.now()) {
    const ms = Math.max(1, this.cfg.rotateMinutes) * 60 * 1000;
    return Math.floor(now / ms);
  }

  // Returns a Playwright proxy object { server, username?, password?, label } or null.
  get(now = Date.now()) {
    if (!this.enabled()) return null;
    const bucket = this.bucket(now);

    if (this.cfg.list && this.cfg.list.length) {
      const entry = this.cfg.list[bucket % this.cfg.list.length];
      return this.parseEntry(entry, bucket);
    }

    const session = `s${bucket.toString(36)}`;
    let username = this.cfg.username || undefined;
    if (this.cfg.sessionParam && username) {
      username = `${username}-${this.cfg.sessionParam}-${session}`;
    }
    return {
      server: this.cfg.server,
      username,
      password: this.cfg.password || undefined,
      label: `${this.cfg.server}#${session}`,
    };
  }

  parseEntry(entry, bucket) {
    try {
      const e = entry.includes('://') ? entry : `http://${entry}`;
      const u = new URL(e);
      return {
        server: `${u.protocol}//${u.host}`,
        username: u.username ? decodeURIComponent(u.username) : undefined,
        password: u.password ? decodeURIComponent(u.password) : undefined,
        label: `${u.host}#${bucket}`,
      };
    } catch (err) {
      log.warn('bad proxy entry', { entry, err: err.message });
      return { server: entry, label: entry };
    }
  }
}

module.exports = { ProxyRotator, proxyRotator: new ProxyRotator() };
