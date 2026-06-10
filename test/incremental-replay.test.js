import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import {
  updateWorkspace, createTicket, updateTicket, deleteTicket,
  addRelation, addComment,
} from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { replayInto, applyEvents } from '../src/replay.js';
import { makeEvent } from '../src/event-schema.js';
import { uploadEvents } from '../src/pg/store.js';
import { pgReplay } from '../src/pg/replay.js';
import { ensureSchema } from '../src/pg/schema.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';

/**
 * SCP-219 — golden oracle for incremental replay. The incremental fast path
 * (apply only the new events) MUST produce a board byte-identical to the
 * always-correct FULL replay, on BOTH backends. We also pin the fallback cases
 * (mid-history insert + create-number collision) and prove the fast path does
 * NOT re-replay the whole log.
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

/* ---------------------------- board snapshots ---------------------------- */

// Normalize a SQLite cache into a backend-agnostic, timestamp-free board.
function sqliteBoard(db) {
  const tickets = db.prepare(
    'SELECT id, uid, number, type, title, description, status, priority, parent_id, branch, pr_url, assignee, labels FROM tickets ORDER BY number'
  ).all().map((r) => ({ ...r, labels: JSON.parse(r.labels) }));
  const history = db.prepare(
    'SELECT ticket_id, field, old_value, new_value, changed_by FROM ticket_history ORDER BY ticket_id, field, id'
  ).all();
  const comments = db.prepare(
    'SELECT ticket_id, author, body FROM ticket_comments ORDER BY ticket_id, id'
  ).all();
  const relations = db.prepare(
    'SELECT from_ticket_id, to_ticket_id, type FROM ticket_relations ORDER BY from_ticket_id, to_ticket_id, type'
  ).all();
  const wsKey = db.prepare('SELECT key FROM workspace WHERE id=1').get().key;
  const nextNum = db.prepare('SELECT next_ticket_number AS n FROM workspace WHERE id=1').get().n;
  return { tickets, history, comments, relations, wsKey, nextNum };
}

async function pgBoard(pool, T) {
  const q = (sql) => pool.query(sql, [T]).then((r) => r.rows);
  const tickets = (await q(
    'SELECT id, uid, number, type, title, description, status, priority, parent_id, branch, pr_url, assignee, labels FROM tickets WHERE tenant_id=$1 ORDER BY number'
  )).map((r) => ({
    id: r.id, uid: r.uid, number: r.number, type: r.type, title: r.title,
    description: r.description, status: r.status, priority: r.priority,
    parent_id: r.parent_id, branch: r.branch, pr_url: r.pr_url, assignee: r.assignee,
    labels: typeof r.labels === 'string' ? JSON.parse(r.labels) : r.labels,
  }));
  const history = (await q(
    'SELECT ticket_id, field, old_value, new_value, changed_by FROM ticket_history WHERE tenant_id=$1 ORDER BY ticket_id, field, id'
  )).map((r) => ({ ticket_id: r.ticket_id, field: r.field, old_value: r.old_value, new_value: r.new_value, changed_by: r.changed_by }));
  const comments = (await q(
    'SELECT ticket_id, author, body FROM ticket_comments WHERE tenant_id=$1 ORDER BY ticket_id, id'
  )).map((r) => ({ ticket_id: r.ticket_id, author: r.author, body: r.body }));
  const relations = (await q(
    'SELECT from_ticket_id, to_ticket_id, type FROM ticket_relations WHERE tenant_id=$1 ORDER BY from_ticket_id, to_ticket_id, type'
  )).map((r) => ({ from_ticket_id: r.from_ticket_id, to_ticket_id: r.to_ticket_id, type: r.type }));
  const ws = (await q('SELECT key, next_ticket_number FROM workspace WHERE tenant_id=$1'))[0];
  return { tickets, history, comments, relations, wsKey: ws.key, nextNum: ws.next_ticket_number };
}

/* ---------------------------- log generators ---------------------------- */

// A varied "base" log: creates, edits, status changes, comments, relations.
function buildBaseLog() {
  const s = createTempScope();
  updateWorkspace(s.db, { key: 'TST', name: 'Test' }, 'bri');
  const epic = createTicket(s.db, { type: 'epic', title: 'Epic', actor: 'bri' });
  const a = createTicket(s.db, { type: 'story', title: 'Story A', parent: epic.id, actor: 'bri' });
  const b = createTicket(s.db, { type: 'bug', title: 'Bug B', actor: 'bri' });
  updateTicket(s.db, a.id, { status: 'in_progress', priority: 'high' }, 'bri', 'Opus 4.8');
  updateTicket(s.db, b.id, { status: 'in_review', labels: ['x', 'y'] }, 'bri');
  addRelation(s.db, a.id, b.id, 'blocks', 'bri');
  addComment(s.db, a.id, 'a note', 'bri', 'Opus 4.8');
  const events = readAllEvents(eventsDir(s.scopeDir));
  s.db.close();
  // Capture the uids so tail batches can reference existing tickets.
  return { events, ids: { epic: epic.id, a: a.id, b: b.id } };
}

// A tail batch (new events that all sort AFTER the base) exercising every kind:
// a new create, an edit of an existing ticket, a status change, a comment, a
// relation add, and a relation remove.
function buildTailBatch(ids, afterTs) {
  const ts = (n) => new Date(Date.parse(afterTs) + 1000 * n).toISOString();
  const c = makeEvent('ticket.create', {
    ticketId: 'NEWULID000000000000000001', number: 4, keyPrefix: 'TST',
    ticketType: 'story', title: 'Tail Story', description: 'desc', status: 'backlog',
    priority: 'low', parentId: null, branch: null, prUrl: null, assignee: null, labels: [],
  }, { actor: 'bri', ts: ts(1) });
  return [
    c,
    makeEvent('ticket.set_field', { ticketId: ids.a, field: 'status', value: 'done' }, { actor: 'bri', ts: ts(2) }),
    makeEvent('ticket.set_field', { ticketId: ids.b, field: 'assignee', value: 'cleo' }, { actor: 'bri', ts: ts(3) }),
    makeEvent('comment.add', { ticketId: ids.a, commentId: 'CMT0000000000000000000001', body: 'tail comment', author: 'bri' }, { actor: 'bri', ts: ts(4) }),
    makeEvent('relation.add', { fromId: c.payload.ticketId, toId: ids.b, type: 'relates_to' }, { actor: 'bri', ts: ts(5) }),
    makeEvent('relation.remove', { fromId: ids.a, toId: ids.b, type: 'blocks' }, { actor: 'bri', ts: ts(6) }),
  ];
}

function maxTs(events) {
  return events.reduce((m, e) => (e.ts > m ? e.ts : m), events[0].ts);
}

/* ============================== SQLite ============================== */

test('SQLite: incremental tail-append == full replay (varied kinds), fast path taken', () => {
  const { events: base, ids } = buildBaseLog();
  const tail = buildTailBatch(ids, maxTs(base));
  const all = [...base, ...tail];

  // Oracle: full replay of the entire log.
  const full = createTempScope();
  replayInto(full.db, all);
  const expected = sqliteBoard(full.db);
  full.db.close();

  // Incremental: replay the base, then fold ONLY the tail on.
  const inc = createTempScope();
  replayInto(inc.db, base);
  const r = applyEvents(inc.db, all, tail);
  assert.equal(r.incremental, true, 'tail-append takes the fast path (no full re-replay)');
  const got = sqliteBoard(inc.db);
  inc.db.close();

  assert.deepEqual(got, expected, 'incremental board == full-replay board');
});

test('SQLite: empty new batch is a no-op fast path', () => {
  const { events: base } = buildBaseLog();
  const inc = createTempScope();
  replayInto(inc.db, base);
  const before = sqliteBoard(inc.db);
  const r = applyEvents(inc.db, base, []);
  assert.equal(r.incremental, true);
  assert.equal(r.applied, 0);
  assert.deepEqual(sqliteBoard(inc.db), before, 'no change on empty batch');
  inc.db.close();
});

test('SQLite: first push from empty log full-replays (safe) and is correct', () => {
  const { events: base } = buildBaseLog();
  const full = createTempScope();
  replayInto(full.db, base);
  const expected = sqliteBoard(full.db);
  full.db.close();

  // SCP-219: a first push (empty existing log) deliberately takes the full
  // replay — it's cheap and robust to a stale cache. Result must still be correct.
  const inc = createTempScope(); // never replayed — empty cache
  const r = applyEvents(inc.db, base, base);
  assert.equal(r.incremental, false, 'empty existing log -> full replay (safe)');
  assert.deepEqual(sqliteBoard(inc.db), expected);
  inc.db.close();
});

test('SQLite FALLBACK (a): mid-history insert (event before max) -> full replay -> correct', () => {
  const { events: base, ids } = buildBaseLog();
  // An event whose ts is BEFORE the base max -> lands in the middle of history.
  const beforeMax = base[2].ts; // somewhere mid-log
  const midEvent = makeEvent(
    'ticket.set_field', { ticketId: ids.a, field: 'title', value: 'Renamed Early' },
    { actor: 'bri', ts: new Date(Date.parse(beforeMax) - 500).toISOString() }
  );
  const all = [...base, midEvent];

  const full = createTempScope();
  replayInto(full.db, all);
  const expected = sqliteBoard(full.db);
  full.db.close();

  const inc = createTempScope();
  replayInto(inc.db, base);
  const r = applyEvents(inc.db, all, [midEvent]);
  assert.equal(r.incremental, false, 'mid-history insert forces full replay');
  assert.deepEqual(sqliteBoard(inc.db), expected, 'fallback board is still correct');
});

test('SQLite FALLBACK (b): create with a colliding number -> renumber -> full replay -> correct', () => {
  const { events: base, ids } = buildBaseLog();
  // Base assigned numbers 1,2,3. A tail create that CLAIMS number 2 (already
  // used) collides -> SCP-110 renumber -> must NOT be a clean append.
  const collide = makeEvent('ticket.create', {
    ticketId: 'COLLIDEULID00000000000001', number: 2, keyPrefix: 'TST',
    ticketType: 'story', title: 'Collider', description: '', status: 'backlog',
    priority: 'medium', parentId: null, branch: null, prUrl: null, assignee: null, labels: [],
  }, { actor: 'bri', ts: new Date(Date.parse(maxTs(base)) + 1000).toISOString() });
  const all = [...base, collide];

  const full = createTempScope();
  replayInto(full.db, all);
  const expected = sqliteBoard(full.db);
  full.db.close();

  const inc = createTempScope();
  replayInto(inc.db, base);
  const r = applyEvents(inc.db, all, [collide]);
  assert.equal(r.incremental, false, 'colliding create forces full replay');
  assert.deepEqual(sqliteBoard(inc.db), expected, 'fallback board is still correct');
  // Sanity: the collider was renumbered to 4 (past the max), not left at 2.
  assert.ok(expected.tickets.some((t) => t.title === 'Collider' && t.number === 4));
  // Reference void to satisfy lint on ids.
  void ids;
});

/* ============================== Postgres ============================== */

test('Postgres: uploadEvents incremental == full replay (varied kinds)', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const { events: base, ids } = buildBaseLog();
  const tail = buildTailBatch(ids, maxTs(base));
  const all = [...base, ...tail];

  // Oracle tenant: full replay of the entire log.
  const Tfull = 'tnt_219_full';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [Tfull]);
  await pgReplay(pool, Tfull, all);
  const expected = await pgBoard(pool, Tfull);

  // Incremental tenant: upload base (replays), then upload the tail (fast path).
  const Tinc = 'tnt_219_inc';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [Tinc]);
  await uploadEvents(pool, Tinc, base);
  await uploadEvents(pool, Tinc, tail);
  const got = await pgBoard(pool, Tinc);

  assert.deepEqual(got, expected, 'PG incremental board == full-replay board');
});

test('Postgres FALLBACK (a): mid-history insert via upload still equals full replay', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const { events: base, ids } = buildBaseLog();
  const midEvent = makeEvent(
    'ticket.set_field', { ticketId: ids.a, field: 'title', value: 'Renamed Early' },
    { actor: 'bri', ts: new Date(Date.parse(base[2].ts) - 500).toISOString() }
  );
  const all = [...base, midEvent];

  const Tfull = 'tnt_219_full_a';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [Tfull]);
  await pgReplay(pool, Tfull, all);
  const expected = await pgBoard(pool, Tfull);

  const Tinc = 'tnt_219_inc_a';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [Tinc]);
  await uploadEvents(pool, Tinc, base);
  await uploadEvents(pool, Tinc, [midEvent]); // forces full replay internally
  const got = await pgBoard(pool, Tinc);

  assert.deepEqual(got, expected, 'PG mid-history fallback board is correct');
});

test('Postgres FALLBACK (b): colliding create via upload still equals full replay', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  const { events: base } = buildBaseLog();
  const collide = makeEvent('ticket.create', {
    ticketId: 'COLLIDEULID00000000000001', number: 2, keyPrefix: 'TST',
    ticketType: 'story', title: 'Collider', description: '', status: 'backlog',
    priority: 'medium', parentId: null, branch: null, prUrl: null, assignee: null, labels: [],
  }, { actor: 'bri', ts: new Date(Date.parse(maxTs(base)) + 1000).toISOString() });
  const all = [...base, collide];

  const Tfull = 'tnt_219_full_b';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [Tfull]);
  await pgReplay(pool, Tfull, all);
  const expected = await pgBoard(pool, Tfull);

  const Tinc = 'tnt_219_inc_b';
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [Tinc]);
  await uploadEvents(pool, Tinc, base);
  await uploadEvents(pool, Tinc, [collide]); // collision -> full replay internally
  const got = await pgBoard(pool, Tinc);

  assert.deepEqual(got, expected, 'PG colliding-create fallback board is correct');
  assert.ok(expected.tickets.some((t) => t.title === 'Collider' && t.number === 4));
});

// Shared test DB across parallel files — don't drop the schema (unique
// tenant_ids isolate; ensureSchema is idempotent).
test.after(async () => {
  if (available) await closePool();
});
