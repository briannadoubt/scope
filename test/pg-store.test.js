import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { updateWorkspace, createTicket, updateTicket } from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { uploadEvents, pullEvents } from '../src/pg/store.js';
import { ensureSchema } from '../src/pg/schema.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';

/**
 * SCP-142 — idempotent Postgres upload + union semantics, and SCP-134 pull
 * semantics backed by Postgres. Upload unions events onto the canonical log
 * (ON CONFLICT DO NOTHING) and re-replays the cache atomically; re-uploading is
 * a no-op; the cache converges to a local replica's board.
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

function buildLog() {
  const s = createTempScope();
  updateWorkspace(s.db, { key: 'TST', name: 'Test' }, 'bri');
  const t = createTicket(s.db, { type: 'story', title: 'Imported', actor: 'bri' });
  updateTicket(s.db, t.id, { status: 'in_progress' }, 'bri', 'Opus 4.8');
  const events = readAllEvents(eventsDir(s.scopeDir));
  s.db.close();
  return events;
}

test('uploadEvents unions onto the log, replays the cache, and is idempotent', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const T = 'tnt_upload';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [T]);
  const events = buildLog();

  const r1 = await uploadEvents(pool, T, events);
  assert.equal(r1.accepted.length, events.length, 'all events accepted first time');
  assert.equal(r1.duplicates.length, 0);
  assert.equal(r1.count, events.length);
  assert.ok(r1.cursor, 'cursor returned');

  // Cache was replayed within the upload txn.
  const tk = await pool.query('SELECT status, title FROM tickets WHERE tenant_id=$1', [T]);
  assert.equal(tk.rows[0].title, 'Imported');
  assert.equal(tk.rows[0].status, 'in_progress');
  const hist = await pool.query('SELECT changed_by FROM ticket_history WHERE tenant_id=$1', [T]);
  assert.ok(hist.rows.some((h) => h.changed_by === 'Opus 4.8 on behalf of bri'), 'attribution applied');

  const r2 = await uploadEvents(pool, T, events);
  assert.equal(r2.accepted.length, 0, 're-upload accepts nothing');
  assert.equal(r2.duplicates.length, events.length, 're-upload is all duplicates');
  assert.equal(r2.count, events.length, 'log size unchanged');
});

test('pullEvents returns events after the ULID cursor; cursor excludes seen', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const T = 'tnt_pull';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [T]);
  const events = buildLog();
  await uploadEvents(pool, T, events);

  const first = await pullEvents(pool, T, {});
  assert.equal(first.events.length, events.length, 'bootstrap returns the full log');
  assert.equal(first.more, false);
  const empty = await pullEvents(pool, T, { since: first.cursor });
  assert.equal(empty.events.length, 0, 'nothing after the cursor');

  // Pagination + `more`.
  const paged = await pullEvents(pool, T, { limit: 1 });
  assert.equal(paged.events.length, 1);
  assert.equal(paged.more, true, 'more=true when truncated');
});

// Shared test DB across parallel files — don't drop the schema (unique
// tenant_ids isolate; ensureSchema is idempotent).
test.after(async () => {
  if (available) await closePool();
});
