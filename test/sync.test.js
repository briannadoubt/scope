import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, createTempScope } from './helpers.js';
import { updateWorkspace, createTicket, updateTicket } from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { openDb } from '../src/db.js';
import { syncFromLog } from '../src/replay.js';

/**
 * SCP-134 — sync pull/push over the event log. The cloud node is "just another
 * replica": pull streams events after a ULID cursor; push unions uploaded
 * events and re-replays (the same deterministic pipeline a local replica runs),
 * so a pushed-into workspace converges to the source workspace's board.
 */

async function server() {
  const s = await startTestServer();
  updateWorkspace(s.scope.db, { key: 'TST', name: 'Test' }, 'setup');
  const url = (p) => `${s.baseUrl}${p}${p.includes('?') ? '&' : '?'}workspace=${s.workspaceId}`;
  const get = async (p) => (await fetch(url(p), { headers: { 'X-Scope-Workspace': s.workspaceId } })).json();
  const post = async (p, body) =>
    (await fetch(url(p), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Scope-Workspace': s.workspaceId },
      body: JSON.stringify(body),
    })).json();
  return { s, get, post };
}

test('pull: bootstrap returns the full log; cursor advances and excludes seen events', async () => {
  const { s, get } = await server();
  try {
    createTicket(s.scope.db, { type: 'story', title: 'A', actor: 'bri' });
    createTicket(s.scope.db, { type: 'story', title: 'B', actor: 'bri' });
    const first = await get('/api/sync/pull');
    assert.ok(first.events.length >= 2, 'bootstrap returns existing events');
    assert.ok(first.cursor, 'cursor present');
    assert.equal(first.count, first.events.length);
    const empty = await get(`/api/sync/pull?since=${first.cursor}`);
    assert.equal(empty.events.length, 0, 'nothing new after the cursor');
  } finally {
    await s.close();
  }
});

test('push: appends new events, is idempotent on re-push, and reports duplicates', async () => {
  const { s, get, post } = await server();
  try {
    // Build foreign events in a separate workspace, then push them in.
    const other = createTempScope();
    updateWorkspace(other.db, { key: 'TST', name: 'Test' }, 'setup');
    const tk = createTicket(other.db, { type: 'bug', title: 'Imported', actor: 'remote' });
    updateTicket(other.db, tk.id, { status: 'in_progress' }, 'remote', 'Sonnet 4.6');
    const foreign = readAllEvents(eventsDir(other.scopeDir));
    other.db.close();

    const r1 = await post('/api/sync/push', { events: foreign });
    assert.equal(r1.accepted.length, foreign.length, 'all foreign events accepted');
    assert.equal(r1.duplicates.length, 0);

    const r2 = await post('/api/sync/push', { events: foreign });
    assert.equal(r2.accepted.length, 0, 're-push accepts nothing');
    assert.equal(r2.duplicates.length, foreign.length, 're-push is all duplicates');

    // The pushed board is now queryable + replayed (attribution preserved).
    const pulled = await get('/api/sync/pull');
    assert.ok(pulled.events.some((e) => e.payload?.title === 'Imported'));
  } finally {
    await s.close();
  }
});

test('convergence: pull from A, push into a fresh replica B => identical board', async () => {
  const { s, get } = await server();
  try {
    const a = s.scope.db;
    const e = createTicket(a, { type: 'epic', title: 'Epic', actor: 'bri' });
    const c = createTicket(a, { type: 'story', title: 'Child', parent: e.id, actor: 'bri' });
    updateTicket(a, c.id, { status: 'in_review' }, 'bri', 'Opus 4.8');
    const dump = await get('/api/sync/pull');

    // Replica B: a bare workspace that receives A's events and replays them.
    const b = createTempScope();
    const { appendEvent, eventsDirForDb } = await import('../src/event-store.js');
    for (const ev of dump.events) appendEvent(eventsDirForDb(b.db), ev);
    syncFromLog(b.db, b.scopeDir);

    const boardA = a.prepare('SELECT id, title, status, parent_id FROM tickets ORDER BY id').all();
    const boardB = b.db.prepare('SELECT id, title, status, parent_id FROM tickets ORDER BY id').all();
    assert.deepEqual(boardB, boardA, 'replica B converges to A');
    const hb = b.db.prepare('SELECT changed_by FROM ticket_history ORDER BY id').all().map((r) => r.changed_by);
    assert.ok(hb.includes('Opus 4.8 on behalf of bri'), 'attribution survives the sync');
    b.db.close();
  } finally {
    await s.close();
  }
});
