/**
 * Tenant isolation via Postgres Row-Level Security (SCP-144).
 *
 * Defense-in-depth on top of the app-layer `tenant_id` filtering that store.js /
 * replay.js already do on every statement. RLS makes cross-tenant reads/writes
 * impossible at the database level — even via raw SQL, and even if the app layer
 * ever forgets a `WHERE tenant_id = $1`.
 *
 * How it works:
 *  - Every tenant-scoped table gets ENABLE + FORCE ROW LEVEL SECURITY. FORCE is
 *    essential: without it the table OWNER (the role the app connects as, in the
 *    common single-role deploy) bypasses RLS entirely, so the policy would be a
 *    no-op for us. FORCE applies the policy to the owner too.
 *  - A single policy per table compares the row's `tenant_id` against a session
 *    GUC, `app.tenant_id`, read via `current_setting('app.tenant_id', true)`.
 *    The `true` ("missing_ok") second arg makes a *never-set* GUC return NULL
 *    rather than erroring.
 *  - FAIL CLOSED: the policy predicate is
 *        tenant_id = current_setting('app.tenant_id', true)
 *    When the GUC is unset, `current_setting(...)` is NULL, and `tenant_id = NULL`
 *    is NULL (not true) for every row — so an unscoped connection sees ZERO rows
 *    and can write none. A missing claim leaks nothing; it just sees an empty db.
 *  - `withTenant` sets the GUC with `SET LOCAL` inside a transaction, so it is
 *    scoped to that transaction on that one pooled connection and is
 *    automatically discarded on COMMIT/ROLLBACK — it can never leak to the next
 *    user of a pooled connection.
 *
 * The GUC is set from the authenticated tenant claim (claim shape owned by
 * SCP-122 / SCP-131); this module only provides the mechanism.
 */

/** The tenant-scoped tables RLS is installed on. Mirrors schema.js. */
export const RLS_TABLES = [
  'events',
  'workspace',
  'tickets',
  'ticket_relations',
  'ticket_comments',
  'ticket_history',
];

/** The session GUC the policies key on. */
export const TENANT_GUC = 'app.tenant_id';

/**
 * SQL that enables + forces RLS and installs a fail-closed tenant policy on
 * every tenant-scoped table. Idempotent: DROP POLICY IF EXISTS before CREATE,
 * and ENABLE/FORCE are no-ops when already set, so this is safe to run on every
 * boot right after ensureSchema().
 */
export const RLS_SQL = RLS_TABLES.map(
  (t) => /* sql */ `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ${t}_tenant_isolation ON ${t};
CREATE POLICY ${t}_tenant_isolation ON ${t}
  USING      (tenant_id = current_setting('${TENANT_GUC}', true))
  WITH CHECK (tenant_id = current_setting('${TENANT_GUC}', true));`
).join('\n');

/**
 * Install RLS policies on all tenant-scoped tables. Run after ensureSchema().
 * @param {import('pg').Pool|import('pg').PoolClient} clientOrPool
 */
export async function applyRls(clientOrPool) {
  await clientOrPool.query(RLS_SQL);
}

/**
 * Remove RLS (tests / rollback). Disables RLS and drops the policies. Idempotent.
 * @param {import('pg').Pool|import('pg').PoolClient} clientOrPool
 */
export async function dropRls(clientOrPool) {
  const sql = RLS_TABLES.map(
    (t) => /* sql */ `
DROP POLICY IF EXISTS ${t}_tenant_isolation ON ${t};
ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${t} DISABLE  ROW LEVEL SECURITY;`
  ).join('\n');
  await clientOrPool.query(sql);
}

/**
 * Run `fn` on a dedicated pooled client inside a transaction with the tenant GUC
 * set (SET LOCAL app.tenant_id = tenantId). Every RLS-protected statement `fn`
 * issues is then transparently scoped to `tenantId` — no explicit WHERE needed
 * for correctness, though the app keeps them as belt-and-suspenders.
 *
 * The callback receives the same transactional client; do NOT BEGIN/COMMIT
 * inside it. On success the txn commits; on throw it rolls back. Because the GUC
 * is SET LOCAL, it dies with the transaction and never leaks to the pool.
 *
 * `set_config($1,$2,true)` is used instead of `SET LOCAL` so the tenant id can
 * be passed as a bound parameter (SET LOCAL takes only literals) — no string
 * interpolation of the (authenticated, but still) tenant id into SQL.
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {string} tenantId
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTenant(pool, tenantId, fn) {
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new Error('withTenant requires a non-empty tenantId');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(name, value, is_local=true) == SET LOCAL, but parameterized.
    await client.query('SELECT set_config($1, $2, true)', [TENANT_GUC, tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be unusable; release below */
    }
    throw err;
  } finally {
    client.release();
  }
}
