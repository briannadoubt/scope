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
 * Optional dedicated app role (SCP-189). Postgres SUPERUSER and BYPASSRLS roles
 * bypass RLS unconditionally — FORCE ROW LEVEL SECURITY cannot touch them. When
 * the pool connects as such a role (e.g. the docker-compose `scope` user, which
 * is both), RLS is silently inert. Setting SCOPE_PG_APP_ROLE to a non-superuser,
 * non-BYPASSRLS role makes `withTenant` SET LOCAL ROLE to it inside every tenant
 * transaction, so the live query paths actually run under the policies.
 * `ensureRls` grants that role the table privileges it needs at boot.
 *
 * Unset (the default) preserves prior behavior: no SET ROLE, and isolation rests
 * on the explicit WHERE tenant_id clauses (plus RLS, if the pool role is one it
 * applies to). The role NAME is interpolated into SET ROLE / GRANT (it cannot be
 * a bind parameter), so it is validated as a strict SQL identifier first.
 *
 * @returns {string|null} the configured app role, or null
 */
export function appRole() {
  const role = process.env.SCOPE_PG_APP_ROLE || null;
  if (role && !/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(role)) {
    throw new Error(`SCOPE_PG_APP_ROLE is not a valid Postgres identifier: ${JSON.stringify(role)}`);
  }
  return role;
}

/**
 * One-call boot setup (SCP-189): install/refresh the RLS policies on every
 * tenant-scoped table and, when SCOPE_PG_APP_ROLE is configured, grant that role
 * the table privileges the live paths need. Idempotent — run on every boot,
 * right after ensureSchema().
 *
 * Wrapped in the same advisory lock ensureSchema() uses, so concurrent booters
 * (parallel test files sharing one database) serialize the DDL instead of racing
 * DROP/CREATE POLICY in the catalog; transient deadlock/serialization failures
 * retry, mirroring ensureSchema (SCP-162).
 *
 * @param {import('pg').Pool|import('pg').PoolClient} clientOrPool
 */
export async function ensureRls(clientOrPool) {
  const role = appRole();
  const isPool = typeof clientOrPool.connect === 'function'; // a Pool

  // Zero-DDL fast path (SCP-194): when RLS is already fully applied (every
  // table forced + every policy present + app-role grants in place when
  // configured), skip the DDL batch entirely. The DROP/CREATE POLICY pair
  // takes ACCESS EXCLUSIVE locks even when nothing changes, and many
  // processes boot concurrently (parallel test files, multi-instance
  // deploys) — re-running it on every boot deadlocked with other processes'
  // data writes, surfacing as transient 500s. NOTE: if RLS_SQL grows new
  // objects, extend this check to cover them or stale fast-paths will skip.
  try {
    const applied = (await clientOrPool.query(
      `SELECT count(*)::int AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname = ANY($1)
          AND c.relrowsecurity AND c.relforcerowsecurity`,
      [RLS_TABLES]
    )).rows[0].forced === RLS_TABLES.length;
    const policies = (await clientOrPool.query(
      `SELECT count(*)::int AS n FROM pg_policies
        WHERE schemaname='public' AND tablename = ANY($1)`,
      [RLS_TABLES]
    )).rows[0].n >= RLS_TABLES.length;
    let granted = true;
    if (role) {
      granted = (await clientOrPool.query(
        `SELECT bool_and(has_table_privilege($2, 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE')) AS ok
           FROM unnest($1::text[]) AS t`,
        [RLS_TABLES, role]
      )).rows[0].ok === true;
      // Also require USAGE on the events seq (SCP-226) — inserts call nextval();
      // without this the fast path would skip and INSERTs 'permission denied'.
      if (granted) {
        granted = (await clientOrPool.query(
          `SELECT has_sequence_privilege($1, 'public.events_seq_seq', 'USAGE') AS ok`,
          [role]
        )).rows[0].ok === true;
      }
    }
    if (applied && policies && granted) return;
  } catch { /* fall through to the full DDL path */ }

  for (let attempt = 1; ; attempt++) {
    const db = isPool ? await clientOrPool.connect() : clientOrPool;
    try {
      await db.query('BEGIN');
      // Same lock id as ensureSchema — RLS DDL serializes with schema DDL too.
      await db.query('SELECT pg_advisory_xact_lock(826349001)');
      await db.query(RLS_SQL);
      if (role) {
        await db.query(`GRANT USAGE ON SCHEMA public TO "${role}"`);
        for (const t of RLS_TABLES) {
          await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO "${role}"`);
        }
        // events.seq is a bigserial (SCP-226): inserts call nextval() on its
        // sequence, so the app role needs USAGE on it (and any future sequence).
        await db.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
      }
      await db.query('COMMIT');
      return;
    } catch (err) {
      try { await db.query('ROLLBACK'); } catch {}
      if ((err.code === '40P01' || err.code === '40001') && attempt < 6) {
        await new Promise((r) => setTimeout(r, 25 * attempt));
        continue;
      }
      throw err;
    } finally {
      if (isPool) db.release();
    }
  }
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
 * When SCOPE_PG_APP_ROLE is configured (SCP-189, see appRole), the transaction
 * also runs SET LOCAL ROLE to that role, so the statements execute under a role
 * RLS actually applies to even when the pool connects as a superuser/BYPASSRLS
 * role. SET LOCAL ROLE reverts on COMMIT/ROLLBACK, exactly like the GUC, so the
 * role never leaks to the next user of the pooled connection.
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
  const role = appRole();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SCP-189: drop superuser/BYPASSRLS privileges for the duration of the txn
    // so the RLS policies below actually bind. Identifier validated in appRole().
    if (role) await client.query(`SET LOCAL ROLE "${role}"`);
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
