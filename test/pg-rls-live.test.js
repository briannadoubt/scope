import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { updateWorkspace, createTicket, updateTicket } from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { ensureSchema } from '../src/pg/schema.js';
import { ensureRls, withTenant, RLS_TABLES, TENANT_GUC } from '../src/pg/rls.js';
import { uploadEvents, pullEvents, snapshotState } from '../src/pg/store.js';
import { pgReplay } from '../src/pg/replay.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';

/**
 * SCP-189 — RLS enforced on the LIVE store/replay paths, beneath the app-layer
 * WHERE clauses. uploadEvents / pullEvents / snapshotState / pgReplay now run
 * inside withTenant (SET LOCAL app.tenant_id + optional SET LOCAL ROLE), so the
 * database itself refuses cross-tenant rows even if a WHERE clause regressed.
 *
 * The dev/test container's pool user (`scope`) is SUPERUSER + BYPASSRLS, which
 * bypasses RLS unconditionally — even FORCE ROW LEVEL SECURITY cannot apply to
 * it. So this file sets SCOPE_PG_APP_ROLE to a dedicated non-superuser,
 * non-BYPASSRLS role: withTenant then SET LOCAL ROLEs into it for every tenant
 * transaction, which is exactly the production deployment shape (the hosted app
 * must run its tenant queries as a role RLS applies to, or RLS means nothing).
 * node:test runs each file in its own process, so this env var cannot leak into
 * the parallel suite.
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

const ROLE = 'scope_rls_live'; // non-superuser app role withTenant drops into
process.env.SCOPE_PG_APP_ROLE = ROLE;

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

const A = 'rlslive_tenant_a';
const B = 'rlslive_tenant_b';

let poolUserIsSuper = null; // recorded at setup, asserted/reported in tests
let aEvents = null;
let bEvents = null;

/** Build a real local event log (same recipe as pg-store.test.js). */
function buildLog(key, title) {
  const s = createTempScope();
  updateWorkspace(s.db, { key, name: key }, 'bri');
  const t = createTicket(s.db, { type: 'story', title, actor: 'bri' });
  updateTicket(s.db, t.id, { status: 'in_progress' }, 'bri', 'Opus 4.8');
  const events = readAllEvents(eventsDir(s.scopeDir));
  s.db.close();
  return events;
}

if (!skip) {
  const pool = getPool();
  await ensureSchema(pool);
  // The app role must exist before ensureRls() grants to it. NOLOGIN is fine:
  // withTenant reaches it via SET LOCAL ROLE on the pool's connections.
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${ROLE}') THEN
      CREATE ROLE ${ROLE} NOSUPERUSER NOBYPASSRLS NOLOGIN;
    END IF;
  END $$;`);
  await pool.query(`ALTER ROLE ${ROLE} NOSUPERUSER NOBYPASSRLS`);
  // THE BOOT CALL under test: policies on all tables + grants to the app role.
  await ensureRls(pool);
  const su = await pool.query(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  poolUserIsSuper = su.rows[0].rolsuper || su.rows[0].rolbypassrls;
  // Start from a clean slate for these tenants (superuser pool bypasses RLS).
  for (const t of RLS_TABLES) {
    await pool.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1)`, [[A, B]]);
  }
}

test('ensureRls is idempotent; withTenant runs as the SCOPE_PG_APP_ROLE app role', { skip }, async () => {
  const pool = getPool();
  await ensureRls(pool); // second run on a booted db must be a clean no-op
  assert.equal(poolUserIsSuper, true,
    'dev container pool user is superuser/BYPASSRLS — the app-role path is what RLS-protects us');
  const who = await withTenant(pool, A, async (c) => {
    const r = await c.query(
      `SELECT current_user AS u,
              current_setting($1, true) AS tenant,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`,
      [TENANT_GUC]
    );
    return r.rows[0];
  });
  assert.equal(who.u, ROLE, 'tenant transactions run as the configured app role');
  assert.equal(who.tenant, A, 'tenant GUC is set inside the transaction');
  assert.equal(who.su, false, 'app role is not superuser');
  assert.equal(who.bypass, false, 'app role cannot bypass RLS');
  // SET LOCAL ROLE must not leak: outside withTenant the pool is itself again.
  const back = await pool.query('SELECT current_user AS u');
  assert.notEqual(back.rows[0].u, ROLE, 'role reverts with the transaction');
});

test('(b) live paths work per tenant through the RLS wiring: upload/pull/snapshot/replay', { skip }, async () => {
  const pool = getPool();
  aEvents = buildLog('AAA', 'Alpha ticket');
  bEvents = buildLog('BBB', 'Beta ticket');

  const rA = await uploadEvents(pool, A, aEvents);
  assert.equal(rA.accepted.length, aEvents.length, 'tenant A: all events accepted');
  assert.equal(rA.duplicates.length, 0);
  assert.equal(rA.count, aEvents.length);
  assert.ok(rA.cursor, 'cursor returned');

  const rA2 = await uploadEvents(pool, A, aEvents);
  assert.equal(rA2.accepted.length, 0, 're-upload is idempotent');
  assert.equal(rA2.duplicates.length, aEvents.length);
  assert.equal(rA2.count, aEvents.length, 'log size unchanged');

  const rB = await uploadEvents(pool, B, bEvents);
  assert.equal(rB.accepted.length, bEvents.length, 'tenant B: all events accepted');
  assert.equal(rB.count, bEvents.length, "B's count excludes A's events");

  const pullA = await pullEvents(pool, A, {});
  assert.equal(pullA.events.length, aEvents.length, 'A pulls exactly its own log');
  assert.equal(pullA.count, aEvents.length);
  const aIds = new Set(aEvents.map((e) => e.id));
  assert.ok(pullA.events.every((e) => aIds.has(e.id)), "A's pull contains only A's events");
  const empty = await pullEvents(pool, A, { since: pullA.cursor });
  assert.equal(empty.events.length, 0, 'nothing after the cursor');

  const snapA = await snapshotState(pool, A);
  assert.equal(snapA.cursor, rA.cursor);
  assert.equal(snapA.state.workspace.key, 'AAA');
  assert.equal(snapA.state.tickets.length, 1, "A's snapshot has only A's ticket");
  assert.equal(snapA.state.tickets[0].title, 'Alpha ticket');
  assert.equal(snapA.state.tickets[0].status, 'in_progress');
  const snapB = await snapshotState(pool, B);
  assert.equal(snapB.state.workspace.key, 'BBB');
  assert.equal(snapB.state.tickets[0].title, 'Beta ticket');

  // pgReplay rebuilds the cache through the same tenant-scoped wiring.
  const rep = await pgReplay(pool, A, aEvents);
  assert.ok(rep.applied > 0, 'replay applied events');
  assert.ok(Array.isArray(rep.renumbered));
  const snapA2 = await snapshotState(pool, A);
  assert.deepEqual(snapA2.state.tickets, snapA.state.tickets, 'replay reproduces the same board');
});

test('(a) tenant A context cannot read tenant B rows — even with NO WHERE clause', { skip }, async () => {
  const pool = getPool();
  // Raw, deliberately unscoped queries — the exact shape of a future bug that
  // forgets WHERE tenant_id. RLS must scope them anyway.
  const seenEvents = await withTenant(pool, A, async (c) =>
    (await c.query('SELECT tenant_id, event_id FROM events')).rows);
  assert.ok(seenEvents.length >= aEvents.length, 'A sees its own events');
  assert.ok(seenEvents.every((r) => r.tenant_id === A), 'no-WHERE events read returns ONLY tenant A');

  const seenTickets = await withTenant(pool, A, async (c) =>
    (await c.query('SELECT tenant_id, title FROM tickets')).rows);
  assert.ok(seenTickets.length >= 1);
  assert.ok(seenTickets.every((r) => r.tenant_id === A), 'no-WHERE tickets read returns ONLY tenant A');
  assert.ok(!seenTickets.some((r) => r.title === 'Beta ticket'), "B's ticket is invisible to A");

  // Even targeting B's row by id, or passing the WRONG tenant in the WHERE
  // (the "bug passes the wrong tenant" case), yields zero rows.
  const targeted = await withTenant(pool, A, async (c) =>
    (await c.query('SELECT event_id FROM events WHERE event_id=$1', [bEvents[0].id])).rows);
  assert.equal(targeted.length, 0, "A cannot read B's event even by exact id");
  const wrongWhere = await withTenant(pool, A, async (c) =>
    (await c.query('SELECT count(*)::int AS c FROM events WHERE tenant_id=$1', [B])).rows[0].c);
  assert.equal(wrongWhere, 0, 'an explicit WHERE tenant_id=B inside A context still returns nothing');

  // Writes: WITH CHECK blocks landing rows under another tenant.
  await assert.rejects(
    () => withTenant(pool, A, (c) =>
      c.query(
        `INSERT INTO events (tenant_id, event_id, ts, kind, body) VALUES ($1,$2,$3,$4,$5)`,
        [B, 'rlslive_forbidden', '2026-06-09T00:00:00.000Z', 'workspace.init', { id: 'rlslive_forbidden' }]
      )),
    /row-level security|policy/i,
    'cross-tenant insert violates WITH CHECK'
  );
});

test('(c) FORCE RLS is active on every tenant table; the owner role is constrained', { skip }, async () => {
  const pool = getPool();
  // Catalog truth: RLS enabled AND forced on all six tables, policy installed.
  const cat = await pool.query(
    `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
    [RLS_TABLES]
  );
  assert.equal(cat.rows.length, RLS_TABLES.length, 'all tenant tables present');
  for (const r of cat.rows) {
    assert.equal(r.relrowsecurity, true, `${r.relname}: RLS enabled`);
    assert.equal(r.relforcerowsecurity, true, `${r.relname}: RLS FORCED (owner subject to policy)`);
  }
  const pols = await pool.query(
    `SELECT tablename FROM pg_policies
      WHERE schemaname='public' AND policyname LIKE '%_tenant_isolation'`
  );
  for (const t of RLS_TABLES) {
    assert.ok(pols.rows.some((r) => r.tablename === t), `${t}: tenant_isolation policy installed`);
  }

  // Behavioral proof that FORCE is what constrains an OWNER. The live tables'
  // owner is the superuser (which nothing constrains), so prove the semantics
  // on a probe table OWNED by the non-superuser app role, with the identical
  // policy SQL: under FORCE the owner sees nothing without a tenant context;
  // dropping only FORCE lets the owner bypass — isolating FORCE as the gate.
  const c = await pool.connect();
  try {
    await c.query('DROP TABLE IF EXISTS rls_owner_probe');
    await c.query(`GRANT CREATE ON SCHEMA public TO "${ROLE}"`); // PG15+ default revokes it
    await c.query(`SET ROLE "${ROLE}"`);
    await c.query('CREATE TABLE rls_owner_probe (tenant_id text NOT NULL, v text)');
    await c.query('ALTER TABLE rls_owner_probe ENABLE ROW LEVEL SECURITY');
    await c.query('ALTER TABLE rls_owner_probe FORCE ROW LEVEL SECURITY');
    await c.query(`CREATE POLICY rls_owner_probe_tenant_isolation ON rls_owner_probe
        USING      (tenant_id = current_setting('${TENANT_GUC}', true))
        WITH CHECK (tenant_id = current_setting('${TENANT_GUC}', true))`);
    await c.query('BEGIN');
    await c.query('SELECT set_config($1,$2,true)', [TENANT_GUC, 'probe_t']);
    await c.query(`INSERT INTO rls_owner_probe VALUES ('probe_t','x')`);
    await c.query('COMMIT');

    const forced = await c.query('SELECT count(*)::int AS c FROM rls_owner_probe');
    assert.equal(forced.rows[0].c, 0, 'OWNER sees zero rows without tenant context — FORCE is live');

    await c.query('ALTER TABLE rls_owner_probe NO FORCE ROW LEVEL SECURITY');
    const unforced = await c.query('SELECT count(*)::int AS c FROM rls_owner_probe');
    assert.equal(unforced.rows[0].c, 1, 'without FORCE the owner bypasses — FORCE was the constraint');
  } finally {
    try {
      await c.query('RESET ROLE');
      await c.query('DROP TABLE IF EXISTS rls_owner_probe');
    } catch { /* best effort */ }
    c.release();
  }
});

// Cleanup as the superuser pool (bypasses RLS, so it can delete freely).
test.after(async () => {
  if (!available) return;
  const pool = getPool();
  try {
    for (const t of RLS_TABLES) {
      await pool.query(`DELETE FROM ${t} WHERE tenant_id = ANY($1)`, [[A, B]]);
    }
    await pool.query('DROP TABLE IF EXISTS rls_owner_probe');
    await pool.query(`REVOKE CREATE ON SCHEMA public FROM "${ROLE}"`);
  } catch { /* best effort */ }
  await closePool();
});
