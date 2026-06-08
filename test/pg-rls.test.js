import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { ensureSchema } from '../src/pg/schema.js';
import { applyRls, withTenant, RLS_TABLES } from '../src/pg/rls.js'; // eslint-disable-line no-unused-vars
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';

/**
 * SCP-144 — tenant isolation via Postgres RLS. With RLS forced on, a connection
 * scoped to tenant A's GUC cannot see or write tenant B's rows even with NO
 * explicit WHERE, and an unscoped connection (no GUC) sees nothing (fail closed).
 *
 * IMPORTANT: Postgres superusers and BYPASSRLS roles bypass RLS unconditionally
 * (even FORCE ROW LEVEL SECURITY cannot apply to them). The local test container
 * connects as the superuser `scope`, so these assertions must run through a
 * dedicated NON-privileged role — which is also exactly the production
 * requirement: the hosted app MUST connect as a non-superuser, non-BYPASSRLS
 * role for RLS to mean anything. We create that role here and drive a pool as it.
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

const A = 'rls_tenant_a';
const B = 'rls_tenant_b';
const APP_ROLE = 'scope_rls_app'; // non-superuser app role used to prove RLS
const APP_PW = 'rls_app_pw';

// A second pool connected as the unprivileged APP_ROLE (RLS actually applies).
let appPool = null;

function appUrl() {
  const u = new URL(pgUrl());
  u.username = APP_ROLE;
  u.password = APP_PW;
  return u.toString();
}

// Drive the PRODUCTION helper (rls.js withTenant) against the unprivileged pool,
// so the deliverable's helper is what's actually under test.
const withAppTenant = (tenantId, fn) => withTenant(appPool, tenantId, fn);

async function seedEvent(client, tenant, id) {
  await client.query(
    `INSERT INTO events (tenant_id, event_id, ts, kind, body)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [tenant, id, '2026-06-07T00:00:00.000Z', 'workspace.init', { id, kind: 'workspace.init' }]
  );
}

if (!skip) {
  const pool = getPool();
  await ensureSchema(pool);
  await applyRls(pool);
  // (Re)create an unprivileged role and grant it table access (no BYPASSRLS).
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${APP_ROLE}') THEN
      CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PW}';
    END IF;
  END $$;`);
  await pool.query(`ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  for (const t of RLS_TABLES) {
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO ${APP_ROLE}`);
  }
  appPool = new pg.Pool({ connectionString: appUrl(), max: 4 });
}

test('RLS forces tenant isolation: A cannot see B, even with no WHERE', { skip }, async () => {
  await withAppTenant(A, (c) => seedEvent(c, A, 'rls_evt_a_1'));
  await withAppTenant(B, (c) => seedEvent(c, B, 'rls_evt_b_1'));

  const seenByA = await withAppTenant(A, async (c) => {
    const r = await c.query('SELECT tenant_id, event_id FROM events'); // no WHERE
    return r.rows;
  });
  assert.ok(seenByA.length >= 1, 'A sees its own rows');
  assert.ok(seenByA.every((row) => row.tenant_id === A), 'A sees ONLY tenant A rows');
  assert.ok(!seenByA.some((row) => row.event_id === 'rls_evt_b_1'), "A cannot see B's row");

  const seenByB = await withAppTenant(B, async (c) => {
    const r = await c.query("SELECT event_id FROM events WHERE event_id='rls_evt_a_1'");
    return r.rows;
  });
  assert.equal(seenByB.length, 0, "B cannot see A's row even targeting it by id");
});

test('RLS WITH CHECK blocks cross-tenant writes', { skip }, async () => {
  await assert.rejects(
    () => withAppTenant(A, (c) => seedEvent(c, B, 'rls_evt_b_forbidden')),
    /row-level security|policy/i,
    "inserting another tenant's row violates WITH CHECK"
  );
});

test('RLS fails closed: no GUC set => zero rows visible', { skip }, async () => {
  await withAppTenant(A, (c) => seedEvent(c, A, 'rls_evt_a_failclosed'));
  const client = await appPool.connect(); // no app.tenant_id GUC
  try {
    const r = await client.query('SELECT count(*)::int AS c FROM events WHERE tenant_id=$1', [A]);
    assert.equal(r.rows[0].c, 0, 'unscoped connection sees no rows (fail closed)');
  } finally {
    client.release();
  }
});

// Cleanup as the superuser pool (it bypasses RLS, so it can delete freely).
test.after(async () => {
  if (!available) return;
  const pool = getPool();
  try {
    await pool.query('DELETE FROM events WHERE tenant_id = ANY($1)', [[A, B]]);
  } catch { /* best effort */ }
  if (appPool) await appPool.end();
  await closePool();
});
