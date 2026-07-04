import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { ensureSchema } from '../src/pg/schema.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';

/**
 * SCP-140 — multi-tenant Postgres schema. Runs against a real Postgres (the
 * docker-compose service). Skips cleanly when none is configured so the rest of
 * the suite (and CI without PG) is unaffected:
 *   docker compose up -d
 *   SCOPE_PG_URL=postgres://scope:scope@localhost:5433/scope_test npm test
 */

// Default to the local docker-compose DB if nothing is set.
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect();
  await c.end();
  available = true;
} catch {
  /* no Postgres reachable — skip */
}
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

test('ensureSchema creates the canonical log + cache tables (idempotent)', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  await ensureSchema(pool); // idempotent
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' ORDER BY table_name`
  );
  const names = rows.map((r) => r.table_name);
  for (const t of ['events', 'workspace', 'tickets', 'ticket_relations', 'ticket_comments', 'ticket_history'])
    assert.ok(names.includes(t), `table ${t} exists`);
});

test('ensureSchema migrates existing ticket tables that predate rank', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE tickets DROP COLUMN IF EXISTS rank');

    await ensureSchema(client);

    const { rows } = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='tickets' AND column_name='rank'`
    );
    assert.equal(rows.length, 1, 'rank column is restored on existing tables');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('events: full envelope round-trips; upload is idempotent (ON CONFLICT DO NOTHING)', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const T = 'tnt_events';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [T]);
  const evt = { v: 1, id: 'E'.repeat(26), ts: '2026-06-07T00:00:00.000Z', actor: 'bri', model: 'Opus 4.8', kind: 'ticket.delete', payload: { ticketId: 'X'.repeat(26) } };
  const ins = `INSERT INTO events (tenant_id, event_id, ts, kind, body)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, event_id) DO NOTHING`;
  const r1 = await pool.query(ins, [T, evt.id, evt.ts, evt.kind, evt]);
  const r2 = await pool.query(ins, [T, evt.id, evt.ts, evt.kind, evt]); // re-upload = no-op
  assert.equal(r1.rowCount, 1, 'first insert applied');
  assert.equal(r2.rowCount, 0, 're-upload is a no-op (idempotent union)');
  const { rows } = await pool.query('SELECT body FROM events WHERE tenant_id=$1', [T]);
  assert.deepEqual(rows[0].body, evt, 'full envelope (incl. model) round-trips verbatim');
});

test('tenant scoping: a query filtered by tenant_id never sees another tenant rows', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  await pool.query('DELETE FROM tickets WHERE tenant_id = ANY($1)', [['tnt_a', 'tnt_b']]);
  const mk = (t, id, uid, n) =>
    pool.query(
      `INSERT INTO tickets (tenant_id,id,uid,number,type,title,status,priority,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'story','T','backlog','medium','now','now')`,
      [t, id, uid, n]
    );
  await mk('tnt_a', 'A-1', 'U'.repeat(26), 1);
  await mk('tnt_b', 'B-1', 'V'.repeat(26), 1);
  const a = await pool.query('SELECT id FROM tickets WHERE tenant_id=$1', ['tnt_a']);
  assert.deepEqual(a.rows.map((r) => r.id), ['A-1'], 'tenant A sees only its row');
  const b = await pool.query('SELECT id FROM tickets WHERE tenant_id=$1', ['tnt_b']);
  assert.deepEqual(b.rows.map((r) => r.id), ['B-1'], 'tenant B sees only its row');
});

// Shared test DB: files run in parallel processes, so do NOT drop the schema
// here (it would wipe tables other files are mid-test on). Isolation comes from
// unique tenant_ids + per-tenant cleanup. ensureSchema is idempotent.
test.after(async () => {
  if (available) await closePool();
});
