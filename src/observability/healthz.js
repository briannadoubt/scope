/**
 * Health-check handler (SCP-155).
 *
 * Exposes a /healthz endpoint the platform (Fly/Render) and an external uptime
 * monitor poll. Two intents:
 *
 *   - Liveness  (always 200 if the process can answer): is the event loop alive?
 *   - Readiness (200 only if the canonical store is reachable): can we serve
 *     real traffic right now?
 *
 * For the hosted node the canonical event log lives in Postgres (SCP-140), so
 * readiness pings Postgres with a trivial `SELECT 1`. The local SQLite cache is
 * disposable (rebuildable via replay) and therefore NOT part of readiness — a
 * lost cache must not flap the health check. If no Postgres URL is configured
 * (pure-local / LAN mode), the check degrades to liveness-only and reports
 * `db: "not-configured"` so it never falsely fails for the non-hosted path.
 *
 * Mount UNAUTHENTICATED and BEFORE authMiddleware — health checkers don't carry
 * the bearer token. The handler returns no tenant data, only a status shape.
 *
 * Response 200:  { status: "ok",   db: "ok" | "not-configured", uptimeSec, version }
 * Response 503:  { status: "fail", db: "unreachable", error, uptimeSec, version }
 */

import { pgConfigured, getPool } from '../pg/pool.js';

/**
 * Build the /healthz Express handler.
 *
 * @param {object} [opts]
 * @param {string} [opts.version]       - reported in the body (pass PKG.version).
 * @param {ReturnType<import('./logging.js').createLogger>} [opts.log] - logger for failures.
 * @param {number} [opts.dbTimeoutMs=2000] - cap the readiness probe so a wedged
 *   DB connection can't hang the health check past the platform's own timeout.
 */
export function healthzHandler({ version = 'unknown', log, dbTimeoutMs = 2000 } = {}) {
  return async (_req, res) => {
    const uptimeSec = Math.round(process.uptime());
    const base = { uptimeSec, version };

    // No canonical store configured → liveness-only. Always healthy.
    if (!pgConfigured()) {
      return res.status(200).json({ status: 'ok', db: 'not-configured', ...base });
    }

    try {
      await withTimeout(probeDb(), dbTimeoutMs);
      res.status(200).json({ status: 'ok', db: 'ok', ...base });
    } catch (err) {
      log?.error('healthz: db unreachable', { err });
      res.status(503).json({ status: 'fail', db: 'unreachable', error: err.message, ...base });
    }
  };
}

/** Cheapest possible round-trip that proves the pool can reach Postgres. */
async function probeDb() {
  const pool = getPool();
  await pool.query('SELECT 1');
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`db probe timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
