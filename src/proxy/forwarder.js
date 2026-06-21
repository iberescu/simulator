'use strict';
const log = require('../logger').child({ mod: 'proxy-fwd' });

/*
 * Chromium silently drops the extended username of an authenticated proxy (the
 * `-cc-US-sessid-...-sesstime-3` params never reach Oxylabs, so geo-targeting and sticky
 * sessions are lost). Work around it the standard way: spin up a local, credential-free
 * forwarder (proxy-chain) per visit that injects the FULL upstream username itself, and hand
 * Chromium only the local `http://127.0.0.1:<port>` address.
 */
let ProxyChain = null;
try { ProxyChain = require('proxy-chain'); }
catch (e) { log.warn('proxy-chain unavailable; proxy params may be dropped by Chromium', { err: e.message }); }

function available() { return !!ProxyChain; }

function upstreamUrl(proxy) {
  const u = new URL(proxy.server); // e.g. http://pr.oxylabs.io:7777
  if (proxy.username) u.username = encodeURIComponent(proxy.username);
  if (proxy.password) u.password = encodeURIComponent(proxy.password);
  return u.toString();
}

// Returns a local proxy URL (no auth) that forwards to the authenticated upstream, or null when
// proxy-chain is unavailable / the proxy needs no auth (then the caller uses it directly).
async function open(proxy) {
  if (!ProxyChain || !proxy || !proxy.username) return null;
  try {
    return await ProxyChain.anonymizeProxy(upstreamUrl(proxy));
  } catch (e) {
    log.warn('forwarder open failed; falling back to direct proxy', { err: e.message });
    return null;
  }
}

async function close(localUrl) {
  if (ProxyChain && localUrl) {
    try { await ProxyChain.closeAnonymizedProxy(localUrl, true); }
    catch (e) { log.warn('forwarder close failed', { err: e.message }); }
  }
}

module.exports = { open, close, available };
