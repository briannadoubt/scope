/**
 * Postgres connection pool for the hosted node (SCP-139/140).
 *
 * The hosted relay backs the canonical event log + replayed cache with Postgres
 * (ADR 0002 / SCP-124). The local-first CLI is unaffected — it keeps using
 * SQLite. Nothing here is imported by the CLI/local path; it loads only when a
 * connection URL is configured.
 *
 * Connection URL resolution: SCOPE_PG_URL, then DATABASE_URL. No hardcoded
 * default — callers that need a pool when none is configured get a clear error.
 */
import pg from 'pg';

let pool = null;

/** The configured Postgres URL, or null if neither env var is set. */
export function pgUrl() {
  return process.env.SCOPE_PG_URL || process.env.DATABASE_URL || null;
}

/** True when a Postgres URL is configured (used to gate hosted-only paths/tests). */
export function pgConfigured() {
  return !!pgUrl();
}

/**
 * The shared connection pool. Lazily created from pgUrl(). Throws if no URL is
 * configured — the hosted path must be explicitly enabled, never assumed.
 */
export function getPool() {
  if (pool) return pool;
  const url = pgUrl();
  if (!url) throw new Error('Postgres not configured: set SCOPE_PG_URL or DATABASE_URL');
  pool = new pg.Pool({ connectionString: url, max: 10 });
  return pool;
}

/** Close the pool (tests / graceful shutdown). */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
