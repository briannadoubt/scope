import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { updateWorkspace, createTicket, updateTicket } from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { uploadEvents, pullEvents, snapshotState } from '../src/pg/store.js';
import { ensureSchema } from '../src/pg/schema.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';

/**
 * SCP-137 — snapshot bootstrap for large logs. A fresh client applies the
 * snapshot (materialized board + tail cursor) instead of replaying the whole
 * log, then pulls events after the cursor. The snapshot must equal the replayed
 * board and leave no tail when caught up (the bootstrap contract).
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
  const e = createTicket(s.db, { type: 'epic', title: 'Epic', actor: 'bri' });
  const a = createTicket(s.db, { type: 'story', title: 'Story', parent: e.id, actor: 'bri' });
  updateTicket(s.db, a.id, { status: 'in_progress' }, 'bri', 'Opus 4.8');
  const events = readAllEvents(eventsDir(s.scopeDir));
  s.db.close();
  return events;
}

test('snapshot returns the materialized board + tail cursor; pull after cursor is empty', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const T = 'tnt_snap';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [T]);
  const events = buildLog();
  const up = await uploadEvents(pool, T, events);

  const snap = await snapshotState(pool, T);
  assert.equal(snap.cursor, up.cursor, 'snapshot cursor is the log high-water mark');
  assert.equal(snap.count, events.length);
  assert.equal(snap.state.workspace.key, 'TST');
  assert.equal(snap.state.tickets.length, 2, 'board materialized in the snapshot');
  assert.ok(snap.state.history.some((h) => h.changed_by === 'Opus 4.8 on behalf of bri'),
    'attribution present in snapshot history');

  // Bootstrap contract: after applying the snapshot, the tail is empty.
  const tail = await pullEvents(pool, T, { since: snap.cursor });
  assert.equal(tail.events.length, 0, 'no tail when caught up to the snapshot cursor');

  // A later event becomes the tail a bootstrapped client would pull.
  const more = buildLog().slice(0, 1); // a fresh workspace.set event (new ULID)
  await uploadEvents(pool, T, more);
  const tail2 = await pullEvents(pool, T, { since: snap.cursor });
  assert.equal(tail2.events.length, 1, 'new events after the snapshot show up as tail');
});

test.after(async () => { if (available) await closePool(); });
