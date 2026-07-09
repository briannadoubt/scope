/**
 * LAN peer gossip (SCP-114) — keep LAN realtime without a central host.
 *
 * Paired machines push new event files to each other as they're appended,
 * over the EXISTING mTLS/device-pairing machinery (src/ca.js, src/devices.js,
 * src/auth.js). There is no new protocol: each gossip round is just
 * `syncWithRemote` (src/sync-client.js) against the peer's /api/sync/push +
 * /api/sync/pull, authenticated by a paired client cert exactly like the iOS
 * client.
 *
 * The realtime path: local change → bus 'change' event → debounce(debounceMs)
 * → push to peers → THEIR push handler appends + replays + emits change →
 * their SSE updates. That achieves the ~100ms acceptance with no central host.
 * A periodic interval tick is the catch-up/repair path (dead peers retried,
 * missed events reconciled).
 *
 * Loop prevention is inherent: push is idempotent by ULID (the peer reports
 * already-known events as duplicates and only emits change when something NEW
 * was accepted), and pulling your own events back is a no-op union (same ULID
 * filename → overwrite-in-place; replay is skipped when the file count didn't
 * move). A later `git pull` of the same changes is equally a no-op.
 *
 * This module is a pure library — `scope serve --gossip` wiring happens in the
 * integrator. Engine: `startGossip(opts)` → `{ stop, runRound, peerStatus }`.
 * Discovery: production callers can feed the engine with the optional
 * `discoverLanPeers()` Bonjour browser; tests inject peers directly.
 */

import https from 'node:https';
import Bonjour from 'bonjour-service';

import { bus, emitChange } from './events.js';
import { getWorkspace } from './db.js';
import { syncWithRemote } from './sync-client.js';
import { workspaceIdFor } from './workspaces.js';

/**
 * Build a minimal fetch-compatible wrapper over node:https with an mTLS agent
 * (cert + key + pinned CA, rejectUnauthorized). Node's global fetch (undici)
 * doesn't take an https.Agent, so we speak https.request directly — only the
 * surface syncWithRemote needs: method/headers/body in, ok/status/json()/text()
 * out.
 *
 * SNI/identity: every Scope hub leaf carries the `scope.local` DNS SAN
 * (src/tls.js collectSans), so we validate the peer's cert against that name —
 * the trust anchor is the pinned per-pairing CA, same as the iOS client.
 *
 * @param {{certPem: string, keyPem: string, caPem: string}} clientCert
 * @param {number} timeoutMs - per-request timeout so a hung peer can't stall a round
 * @returns {{agent: https.Agent, fetchImpl: Function}}
 */
function makeMtlsFetch({ certPem, keyPem, caPem }, timeoutMs) {
  if (!certPem || !keyPem || !caPem) {
    throw new Error('gossip: clientCert must provide certPem, keyPem and caPem');
  }
  const agent = new https.Agent({
    cert: certPem,
    key: keyPem,
    ca: caPem,
    rejectUnauthorized: true,
    keepAlive: true,
    maxSockets: 4,
  });
  const fetchImpl = (url, init = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const port = u.port || 443;
      const req = https.request(
        {
          hostname: u.hostname,
          port,
          path: `${u.pathname}${u.search}`,
          method: init.method || 'GET',
          headers: { host: `scope.local:${port}`, ...(init.headers || {}) },
          agent,
          servername: 'scope.local',
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { body += c; });
          res.on('end', () =>
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              async json() { return body ? JSON.parse(body) : null; },
              async text() { return body; },
            })
          );
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`gossip request timed out after ${timeoutMs}ms`)));
      req.on('error', reject);
      if (init.body) req.write(init.body);
      req.end();
    });
  return { agent, fetchImpl };
}

/** Normalize a peer base URL for use as a stable map key / remote id. */
function normUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  return url.replace(/\/+$/, '');
}

/**
 * Start the gossip engine for one workspace (SCP-114).
 *
 * @param {object} opts
 * @param {string} opts.scopeDir - the local .scope dir (event log path resolves from here)
 * @param {import('better-sqlite3').Database} opts.db - open handle on the same workspace
 * @param {() => Array<{url: string, clientCert?: object}>|Promise<Array>} opts.getPeers
 *   Returns the current peer set as https base URLs (e.g. from
 *   `discoverLanPeers().getPeers`, or injected directly in tests). May be
 *   async. A peer entry may carry its own `clientCert` when it was paired
 *   against a different CA than the default credential.
 * @param {{certPem: string, keyPem: string, caPem: string}} [opts.clientCert]
 *   The paired device credential used for every peer that doesn't override it:
 *   cert/key issued via `scope pair` against the peer's CA, plus that CA's cert
 *   for server verification. Required unless `fetchImpl` is injected.
 * @param {number} [opts.intervalMs=5000] - catch-up tick (retries dead peers)
 * @param {number} [opts.debounceMs=50] - settle window after a local change
 * @param {number} [opts.requestTimeoutMs=10000] - per-HTTP-request timeout
 * @param {Function} [opts.fetchImpl] - injectable fetch for tests; replaces the
 *   built-in mTLS fetch for ALL peers.
 * @returns {{
 *   stop: () => Promise<void>,
 *   runRound: () => Promise<Array<{url: string, ok: boolean}>>,
 *   peerStatus: () => Array<{url: string, workspaceId: string|null, lastError: string|null, lastSyncAt: number|null}>,
 * }}
 */
export function startGossip({
  scopeDir,
  db,
  getPeers,
  clientCert,
  intervalMs = 5000,
  debounceMs = 50,
  requestTimeoutMs = 10000,
  fetchImpl,
} = {}) {
  if (!scopeDir) throw new Error('startGossip: scopeDir is required');
  if (!db) throw new Error('startGossip: db is required');
  if (typeof getPeers !== 'function') throw new Error('startGossip: getPeers() is required');
  if (!fetchImpl && !clientCert) {
    throw new Error('startGossip: clientCert {certPem,keyPem,caPem} (or a fetchImpl) is required');
  }

  // The id the hub tags this workspace's bus events with — used to ignore
  // changes belonging to OTHER workspaces attached to the same hub process.
  const selfWorkspaceId = workspaceIdFor(scopeDir);

  /**
   * Per-peer state, keyed by normalized base URL.
   * workspaceId — the peer's workspace id for our key, resolved once via
   *   GET /api/workspaces and cached (cleared on error so a restarted peer
   *   with a re-attached workspace re-resolves).
   * @type {Map<string, {url:string, agent:https.Agent|null, fetch:Function|null, workspaceId:string|null, lastError:string|null, lastSyncAt:number|null}>}
   */
  const peerState = new Map();

  let stopped = false;
  let debounceTimer = null;
  let inFlight = null; // promise of the round currently running
  let rerun = false; // a change arrived mid-round → run again right after
  let stopPromise = null;

  /**
   * Resolve which workspace id to sync with on the peer: the same project on
   * both machines shares a workspace KEY (e.g. "SCP"), while workspace IDs are
   * per-machine path hashes. Match by key, case-insensitively.
   */
  async function resolveRemoteWorkspace(st, localKey) {
    if (st.workspaceId) return st.workspaceId;
    const resp = await st.fetch(`${st.url}/api/workspaces`, { headers: { accept: 'application/json' } });
    if (!resp.ok) throw new Error(`GET /api/workspaces failed: HTTP ${resp.status}`);
    const list = await resp.json();
    const match = (Array.isArray(list) ? list : []).find(
      (w) => typeof w?.key === 'string' && w.key.toUpperCase() === localKey.toUpperCase()
    );
    if (!match) throw new Error(`peer has no workspace with key "${localKey}"`);
    st.workspaceId = match.id;
    return match.id;
  }

  /** One gossip round: push+pull against every current peer, errors isolated. */
  async function gossipRound() {
    const results = [];

    // Without an initialized workspace key we can't match the peer's replica —
    // skip quietly; the interval tick retries once `scope init` has run.
    let localKey = null;
    try { localKey = getWorkspace(db)?.key || null; } catch { localKey = null; }
    if (!localKey) return results;

    let peers = [];
    try { peers = (await getPeers()) || []; } catch { peers = []; }

    let pulledTotal = 0;
    for (const peer of peers) {
      if (stopped) break;
      const url = normUrl(peer?.url);
      if (!url) continue;
      let st = peerState.get(url);
      if (!st) {
        st = { url, agent: null, fetch: null, workspaceId: null, lastError: null, lastSyncAt: null };
        peerState.set(url, st);
      }
      try {
        if (!st.fetch) {
          if (fetchImpl) {
            st.fetch = fetchImpl;
          } else {
            const built = makeMtlsFetch(peer.clientCert || clientCert, requestTimeoutMs);
            st.agent = built.agent;
            st.fetch = built.fetchImpl;
          }
        }
        const remoteWorkspace = await resolveRemoteWorkspace(st, localKey);
        const r = await syncWithRemote(db, scopeDir, {
          remote: st.url,
          remoteWorkspace,
          fetchImpl: st.fetch,
        });
        st.lastError = null;
        st.lastSyncAt = Date.now();
        pulledTotal += r.pulled;
        results.push({ url: st.url, ok: true, ...r });
      } catch (e) {
        // Per-peer isolation: a dead peer must not break the round. Remember
        // the failure (peerStatus) and keep retrying on the interval. Drop the
        // cached workspace id — a restarted peer may have re-attached.
        st.lastError = e?.message || String(e);
        st.workspaceId = null;
        results.push({ url: st.url, ok: false, error: st.lastError });
      }
    }

    // Pulled events were appended + replayed by syncWithRemote, but nothing
    // notified OUR subscribers (SSE / sibling gossip hops). Emit a coarse
    // change; tagged source:'gossip' so our own bus handler ignores it (the
    // round already reconciled — re-gossiping it would only burn a no-op
    // round; downstream loops still terminate via ULID idempotence anyway).
    if (pulledTotal > 0 && !stopped) {
      emitChange({ type: 'gossip.pulled', workspace: selfWorkspaceId, pulled: pulledTotal, source: 'gossip' });
    }
    return results;
  }

  /**
   * Run a round, guarded to one at a time. If a round is already in flight the
   * call returns THAT round's promise and queues exactly one follow-up round,
   * so a change landing mid-round is still propagated promptly instead of
   * waiting for the next interval tick.
   */
  function runRound() {
    if (stopped) return Promise.resolve([]);
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = gossipRound()
      .catch(() => [])
      .finally(() => {
        inFlight = null;
        if (rerun && !stopped) {
          rerun = false;
          runRound();
        }
      });
    return inFlight;
  }

  /** Debounced reaction to local mutations — the ~100ms realtime path. */
  function onBusChange(detail) {
    if (stopped) return;
    if (detail?.source === 'gossip') return; // our own post-pull notification
    // Ignore changes tagged for a different workspace on a multi-workspace
    // hub. Untagged events (direct repo calls outside a request context) are
    // gossiped — a spurious round is a cheap no-op.
    if (detail?.workspace && detail.workspace !== selfWorkspaceId) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runRound();
    }, debounceMs);
  }

  bus.on('change', onBusChange);
  const interval = setInterval(runRound, intervalMs);
  runRound(); // initial catch-up: reconcile whatever happened while we were down

  /** Snapshot of per-peer health for status UIs / logs. */
  function peerStatus() {
    return [...peerState.values()].map(({ url, workspaceId, lastError, lastSyncAt }) => ({
      url, workspaceId, lastError, lastSyncAt,
    }));
  }

  /**
   * Tear down: detach the bus listener, clear both timers, wait out any
   * in-flight round, and destroy the keep-alive mTLS agents. Idempotent.
   */
  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    bus.off('change', onBusChange);
    clearInterval(interval);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    stopPromise = (async () => {
      try { await inFlight; } catch { /* round already isolates errors */ }
      for (const st of peerState.values()) {
        try { st.agent?.destroy(); } catch { /* already gone */ }
      }
      peerState.clear();
    })();
    return stopPromise;
  }

  return { stop, runRound, peerStatus };
}

/**
 * Optional production discovery (SCP-114): browse Bonjour for other Scope hubs
 * on the LAN — the same `_scope._tcp` service src/server.js advertises — and
 * expose them in the exact shape `startGossip({ getPeers })` wants.
 *
 * Only https peers are returned (gossip authenticates with mTLS; an http hub
 * has no cert auth to offer). The browser also reports each peer's CA
 * fingerprint from the TXT record so callers can filter to CAs they've
 * actually paired with — and should pass their own URL(s) in `excludeUrls` so
 * a hub doesn't gossip with itself.
 *
 * Untestable in CI (multicast); kept deliberately thin.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.excludeUrls=[]] - our own advertised URL(s)
 * @param {(peer: {url:string,name:string,caFingerprint:string|null}) => void} [opts.onUp]
 * @param {(peer: {url:string,name:string,caFingerprint:string|null}) => void} [opts.onDown]
 * @returns {{getPeers: () => Array<{url:string,name:string,caFingerprint:string|null}>, stop: () => void}}
 */
export function discoverLanPeers({ excludeUrls = [], onUp, onDown } = {}) {
  const bonjour = new Bonjour();
  const peers = new Map();
  const excluded = new Set(excludeUrls.map(normUrl).filter(Boolean));

  const urlFor = (svc) => {
    const txt = svc?.txt || {};
    if (txt.scheme !== 'https') return null; // mTLS gossip needs the HTTPS LAN listener
    const host = txt.host || svc.host;
    const port = txt.port || svc.port;
    if (!host || !port) return null;
    return normUrl(`https://${host}:${port}`);
  };

  const browser = bonjour.find({ type: 'scope', protocol: 'tcp' });
  browser.on('up', (svc) => {
    const url = urlFor(svc);
    if (!url || excluded.has(url) || peers.has(url)) return;
    const peer = { url, name: svc.name || 'scope', caFingerprint: svc.txt?.ca_fp || null };
    peers.set(url, peer);
    onUp?.(peer);
  });
  browser.on('down', (svc) => {
    const url = urlFor(svc);
    const peer = url ? peers.get(url) : null;
    if (!peer) return;
    peers.delete(url);
    onDown?.(peer);
  });

  return {
    getPeers: () => [...peers.values()],
    stop() {
      try { browser.stop(); } catch { /* not started */ }
      try { bonjour.destroy(); } catch { /* already destroyed */ }
    },
  };
}
