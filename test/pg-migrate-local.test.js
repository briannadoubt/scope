import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { updateWorkspace, createTicket, updateTicket } from '../src/repo.js';
import { ensureSchema } from '../src/pg/schema.js';
import { migrateLocalLog } from '../src/pg/migrate-local.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';

/**
 * SCP-145 — migrate a local .scope/events log into a hosted tenant. The migrated
 * tenant's replayed board must match the user's local board exactly, and the
 * migration must be re-runnable (idempotent: a second run applies nothing).
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

test('migrateLocalLog imports the local log; PG board matches; idempotent', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const T = 'mig_tenant_basic';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [T]);

  // Build a real local log via repo.js (valid key 'TST' set first).
  const s = createTempScope();
  updateWorkspace(s.db, { key: 'TST', name: 'Test Project' }, 'bri');
  const t1 = createTicket(s.db, { type: 'story', title: 'First', actor: 'bri' });
  const t2 = createTicket(s.db, { type: 'bug', title: 'Second', actor: 'bri' });
  updateTicket(s.db, t1.id, { status: 'in_progress' }, 'bri', 'Opus 4.8');

  // Capture the local board (the golden) before closing the db.
  const localTickets = s.db
    .prepare('SELECT id, title, status, type FROM tickets ORDER BY id')
    .all();
  const localKey = s.db.prepare('SELECT key FROM workspace WHERE id = 1').get().key;
  s.db.close();

  // Migrate.
  const r1 = await migrateLocalLog(pool, T, s.scopeDir);
  assert.ok(r1.read > 0, 'read events from the local log');
  assert.equal(r1.applied, r1.read, 'first migration applies every event');
  assert.equal(r1.duplicates, 0, 'nothing pre-existing');

  // Hosted board matches the local board exactly.
  const pgTickets = (
    await pool.query(
      'SELECT id, title, status, type FROM tickets WHERE tenant_id=$1 ORDER BY id',
      [T]
    )
  ).rows;
  assert.deepEqual(pgTickets, localTickets, 'migrated board == local board');

  const pgKey = (
    await pool.query('SELECT key FROM workspace WHERE tenant_id=$1', [T])
  ).rows[0].key;
  assert.equal(pgKey, localKey, 'workspace key migrated');

  // Re-runnable: a second migration is a pure no-op union.
  const r2 = await migrateLocalLog(pool, T, s.scopeDir);
  assert.equal(r2.applied, 0, 're-migration applies nothing');
  assert.equal(r2.duplicates, r2.read, 're-migration is all duplicates');
  assert.equal(r2.count, r1.count, 'log size unchanged on re-run');

  s.cleanup();
});

test('migrateLocalLog on an empty/absent log is a safe no-op', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const T = 'mig_tenant_empty';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [T]);

  const r = await migrateLocalLog(pool, T, '/tmp/scope-does-not-exist-xyz');
  assert.deepEqual(r, { read: 0, applied: 0, duplicates: 0, cursor: null, count: 0 });
});

test.after(async () => {
  if (available) await closePool();
});
