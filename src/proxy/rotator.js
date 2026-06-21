'use strict';
const crypto = require('crypto');
const config = require('./../config');
const log = require('./../logger').child({ mod: 'proxy' });

/*
 * Rotating-proxy resolver.
 *  - Mode A (single endpoint): one PROXY_SERVER with optional geo + sticky-session injection.
 *      The username is composed using the residential-provider convention (Oxylabs et al.):
 *        customer-USER-cc-<COUNTRY>-<sessionParam>-<session>-sesstime-<minutes>
 *      e.g. customer-iberescu-cc-US-sessid-ab12cd-sesstime-3
 *      * PROXY_COUNTRY pins the exit country (e.g. US).
 *      * PROXY_SESSION_MINUTES (Oxylabs `sesstime`) is how long the same IP is held.
 *      * PROXY_PER_SESSION=true gives each visit its own sticky IP (a fresh `session` seed per
 *        get()); otherwise the session id is derived from a PROXY_ROTATE_MINUTES time bucket and
 *        shared by all concurrent visits in that window.
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

  // Compose the provider username with optional country / sticky-session / session-time params.
  buildUsername(session) {
    let username = this.cfg.username;
    if (!username) return undefined;
    if (this.cfg.country) username += `-cc-${this.cfg.country}`;
    if (this.cfg.sessionParam && session) username += `-${this.cfg.sessionParam}-${session}`;
    if (this.cfg.sessionMinutes > 0) username += `-sesstime-${this.cfg.sessionMinutes}`;
    return username;
  }

  // Returns a Playwright proxy object { server, username?, password?, label } or null.
  // opts.session: a seed (e.g. the visit cid) so one browsing session keeps one sticky IP.
  get(opts = {}) {
    if (!this.enabled()) return null;
    const now = opts.now || Date.now();

    if (this.cfg.list && this.cfg.list.length) {
      const bucket = this.bucket(now);
      return this.parseEntry(this.cfg.list[bucket % this.cfg.list.length], bucket);
    }

    // perSession => a fresh sticky IP per visit; otherwise a time-bucketed IP shared by all
    // visits within the current PROXY_ROTATE_MINUTES window.
    const session = this.cfg.perSession
      ? (opts.session || crypto.randomBytes(6).toString('hex'))
      : `s${this.bucket(now).toString(36)}`;
    const host = this.cfg.server.replace(/^https?:\/\//, '');
    return {
      server: this.cfg.server,
      username: this.buildUsername(session),
      password: this.cfg.password || undefined,
      label: `${host}#${this.cfg.country || 'any'}/${session}`,
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
