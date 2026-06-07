/**
 * /healthz handler for the hosted node (SCP-149).
 *
 * Replaces the LAN hub's self-healing (src/hub.js: port-race binding,
 * Bonjour/mDNS discovery, probeHub scan, startHubWatchdog). In the cloud the
 * load balancer owns liveness: it healthchecks /healthz, drains a node that
 * fails, and routes around it. A node is healthy only when:
 *
 *   1. Postgres is reachable (a trivial `SELECT 1` round-trips), AND
 *   2. this node's dedicated LISTEN connection is live — because a node whose
 *      LISTEN dropped is silently missing cross-node fan-out (SCP-146): it still
 *      serves REST/SSE but its SSE clients stop seeing other nodes' writes. That
 *      node must be pulled from rotation, not left limping.
 *
 * Returns a plain handler so server.js can mount it on either the express app
 * or a bare http server without pulling express types in here.
 */

/**
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool - the shared pool (getPool()).
 * @param {{ listening: () => boolean }} deps.bus - the realtime bus (bus.js).
 * @param {number} [deps.timeoutMs=2000] - DB probe timeout.
 * @returns {(req, res) => void} an http/express handler for GET /healthz.
 */
export function makeHealthz({ pool, bus, timeoutMs = 2000 } = {}) {
  if (!pool) throw new Error('makeHealthz requires a pg Pool');
  if (!bus || typeof bus.listening !== 'function') {
    throw new Error('makeHealthz requires a bus exposing listening()');
  }

  return async function healthz(_req, res) {
    const checks = { db: false, listen: false };
    let status = 200;

    // DB reachability with a bounded timeout — a hung DB must read as unhealthy,
    // not as a hung healthcheck (which would wedge the LB).
    try {
      await withTimeout(pool.query('SELECT 1'), timeoutMs);
      checks.db = true;
    } catch {
      checks.db = false;
    }

    // LISTEN liveness is local + synchronous.
    checks.listen = bus.listening();

    const ok = checks.db && checks.listen;
    if (!ok) status = 503;

    const body = JSON.stringify({ status: ok ? 'ok' : 'unhealthy', checks });
    // Works whether res is an express Response or a bare ServerResponse.
    if (typeof res.status === 'function') {
      res.status(status).type('application/json').send(body);
    } else {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    }
  };
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('healthz: db probe timed out')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}
