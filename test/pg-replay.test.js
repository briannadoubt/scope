import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import {
  updateWorkspace, createTicket, updateTicket, deleteTicket,
  addRelation, addComment,
} from '../src/repo.js';
import { replayInto } from '../src/replay.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { pgReplay } from '../src/pg/replay.js';
import { ensureSchema, dropSchema } from '../src/pg/schema.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';

/**
 * SCP-141 — golden test: the SAME event log replayed through the SQLite
 * `replayInto` and the Postgres `pgReplay` must yield identical board state
 * (tickets, numbers, relations, comments, attributed history). This is what
 * lets the hosted node be "just another replica" — its projection matches a
 * local replica's exactly.
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

// Build a realistic event log via the normal repo write path.
function buildLog() {
  const s = createTempScope();
  updateWorkspace(s.db, { key: 'TST', name: 'Test' }, 'bri');
  const epic = createTicket(s.db, { type: 'epic', title: 'Epic', actor: 'bri' });
  const a = createTicket(s.db, { type: 'story', title: 'Story A', parent: epic.id, actor: 'bri' });
  const b = createTicket(s.db, { type: 'bug', title: 'Bug B', actor: 'bri' });
  updateTicket(s.db, a.id, { status: 'in_progress', priority: 'high' }, 'bri', 'Opus 4.8');
  updateTicket(s.db, b.id, { status: 'in_review', labels: ['x', 'y'] }, 'bri');
  addRelation(s.db, a.id, b.id, 'blocks', 'bri');
  addComment(s.db, a.id, 'a note', 'bri', 'Opus 4.8');
  const c = createTicket(s.db, { type: 'story', title: 'Doomed', actor: 'bri' });
  deleteTicket(s.db, c.id, 'bri'); // tombstone: its rows must be cleaned up
  const events = readAllEvents(eventsDir(s.scopeDir));
  s.db.close();
  return events;
}

const norm = {
  tickets: (rows) =>
    rows.map((r) => ({
      id: r.id, uid: r.uid, number: r.number, type: r.type, title: r.title,
      description: r.description, status: r.status, priority: r.priority,
      parent_id: r.parent_id ?? null, branch: r.branch ?? null, pr_url: r.pr_url ?? null,
      assignee: r.assignee ?? null,
      labels: typeof r.labels === 'string' ? JSON.parse(r.labels) : r.labels,
    })),
  history: (rows) => rows.map((r) => ({ field: r.field, old_value: r.old_value, new_value: r.new_value, changed_by: r.changed_by })),
  comments: (rows) => rows.map((r) => ({ author: r.author, body: r.body })),
  relations: (rows) => rows.map((r) => ({ from: r.from_ticket_id, to: r.to_ticket_id, type: r.type })),
};

test('SQLite replay and Postgres replay project identical board state', { skip }, async () => {
  const events = buildLog();

  // SQLite side: replay into a fresh cache.
  const sq = createTempScope();
  replayInto(sq.db, events);
  const sqlite = {
    tickets: norm.tickets(sq.db.prepare('SELECT * FROM tickets ORDER BY number').all()),
    history: norm.history(sq.db.prepare('SELECT * FROM ticket_history ORDER BY ticket_id, field, id').all()),
    comments: norm.comments(sq.db.prepare('SELECT * FROM ticket_comments ORDER BY ticket_id, id').all()),
    relations: norm.relations(sq.db.prepare('SELECT * FROM ticket_relations ORDER BY from_ticket_id, to_ticket_id, type').all()),
    wsKey: sq.db.prepare('SELECT key FROM workspace WHERE id=1').get().key,
  };
  sq.db.close();

  // Postgres side: replay the same events for a tenant.
  const pool = getPool();
  await ensureSchema(pool);
  const T = 'tnt_golden';
  await pgReplay(pool, T, events);
  const q = (sql) => pool.query(sql, [T]).then((r) => r.rows);
  const postgres = {
    tickets: norm.tickets(await q('SELECT * FROM tickets WHERE tenant_id=$1 ORDER BY number')),
    history: norm.history(await q('SELECT * FROM ticket_history WHERE tenant_id=$1 ORDER BY ticket_id, field, id')),
    comments: norm.comments(await q('SELECT * FROM ticket_comments WHERE tenant_id=$1 ORDER BY ticket_id, id')),
    relations: norm.relations(await q('SELECT * FROM ticket_relations WHERE tenant_id=$1 ORDER BY from_ticket_id, to_ticket_id, type')),
    wsKey: (await q('SELECT key FROM workspace WHERE tenant_id=$1'))[0].key,
  };

  assert.deepEqual(postgres.tickets, sqlite.tickets, 'tickets match');
  assert.deepEqual(postgres.history, sqlite.history, 'attributed history matches');
  assert.deepEqual(postgres.comments, sqlite.comments, 'comments match');
  assert.deepEqual(postgres.relations, sqlite.relations, 'relations match');
  assert.equal(postgres.wsKey, sqlite.wsKey, 'workspace key matches');
  // Sanity: the tombstoned ticket and its rows are gone on both sides.
  assert.ok(!postgres.tickets.some((t) => t.title === 'Doomed'));
  assert.ok(postgres.history.some((h) => h.changed_by === 'Opus 4.8 on behalf of bri'));
});

test.after(async () => {
  if (available) { try { await dropSchema(getPool()); } catch {} await closePool(); }
});
