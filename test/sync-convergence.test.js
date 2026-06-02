import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createTempScope } from './helpers.js';
import { ensureEventLog } from '../src/backfill.js';
import { syncFromLog } from '../src/replay.js';
import { eventsDir } from '../src/event-store.js';
import {
  createTicket,
  updateTicket,
  addRelation,
  addComment,
  listTickets,
  listRelations,
  listComments,
} from '../src/repo.js';

function board(db) {
  const tickets = listTickets(db).map((t) => ({
    id: t.id, number: t.number, type: t.type, title: t.title, status: t.status,
    priority: t.priority, parent_id: t.parent_id, assignee: t.assignee, labels: t.labels,
  }));
  const relations = tickets
    .flatMap((t) => listRelations(db, t.id).map((r) => `${t.id}|${r.to_ticket_id}|${r.type}`))
    .sort();
  const comments = tickets
    .flatMap((t) => listComments(db, t.id).map((c) => `${t.id}|${c.author}|${c.body}`))
    .sort();
  return { tickets, relations, comments };
}

/** "git pull": union the event files from `src` into `dst` (only ever .json events). */
function pull(srcScopeDir, dstScopeDir) {
  const src = eventsDir(srcScopeDir);
  const dst = eventsDir(dstScopeDir);
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    if (f.endsWith('.json') && !f.startsWith('.')) copyFileSync(join(src, f), join(dst, f));
  }
}

test('two clones diverge, merge by union of event files, and converge to an identical board', () => {
  const origin = createTempScope();
  const A = createTempScope();
  const B = createTempScope();
  try {
    // Origin seeds shared state and makes the log authoritative.
    const epic = createTicket(origin.db, { type: 'epic', title: 'Shared', actor: 'origin' });
    const s1 = createTicket(origin.db, { type: 'story', title: 'Login', parent: epic.id, actor: 'origin' });
    ensureEventLog(origin.db, origin.scopeDir);

    // Both clones pull origin's log and rebuild — no SQLite file is ever copied.
    pull(origin.scopeDir, A.scopeDir);
    pull(origin.scopeDir, B.scopeDir);
    syncFromLog(A.db, A.scopeDir);
    syncFromLog(B.db, B.scopeDir);
    assert.deepEqual(board(A.db), board(B.db), 'clones start identical');

    // DIVERGE offline. A advances the shared story + comments.
    const aStory = listTickets(A.db).find((t) => t.title === 'Login');
    updateTicket(A.db, aStory.id, { status: 'in_progress', assignee: 'alice' }, 'alice');
    addComment(A.db, aStory.id, 'on it', 'alice');

    // B adds a new story and links it. (Independent number allocation — the
    // resolver de-collides at replay.)
    const bEpic = listTickets(B.db).find((t) => t.type === 'epic');
    const bStory = createTicket(B.db, { type: 'story', title: 'Logout', parent: bEpic.id, actor: 'bob' });
    addRelation(B.db, bStory.id, aStory ? listTickets(B.db).find((t) => t.title === 'Login').id : bStory.id, 'relates_to', 'bob');

    // MERGE both directions (git pull A->B and B->A) and rebuild from the union.
    pull(A.scopeDir, B.scopeDir);
    pull(B.scopeDir, A.scopeDir);
    syncFromLog(A.db, A.scopeDir);
    syncFromLog(B.db, B.scopeDir);

    const ba = board(A.db);
    const bb = board(B.db);
    assert.deepEqual(ba, bb, 'after exchanging event logs both clones are byte-identical');

    // The merge is a true union: both peers' divergent changes survive.
    assert.ok(ba.tickets.some((t) => t.title === 'Login' && t.status === 'in_progress'), "A's edit present");
    assert.ok(ba.tickets.some((t) => t.title === 'Logout'), "B's new ticket present");
    assert.ok(ba.comments.some((c) => c.includes('on it')), "A's comment present");
    assert.ok(ba.relations.some((r) => r.includes('relates_to')), "B's relation present");
  } finally {
    origin.cleanup();
    A.cleanup();
    B.cleanup();
  }
});

test('pulling the same log twice is idempotent (no duplicate state)', () => {
  const origin = createTempScope();
  const clone = createTempScope();
  try {
    createTicket(origin.db, { type: 'story', title: 'Once', actor: 'o' });
    ensureEventLog(origin.db, origin.scopeDir);

    pull(origin.scopeDir, clone.scopeDir);
    syncFromLog(clone.db, clone.scopeDir);
    const first = board(clone.db);

    // Pull again (same files overwrite) + sync — identical, no duplicates.
    pull(origin.scopeDir, clone.scopeDir);
    syncFromLog(clone.db, clone.scopeDir);
    assert.deepEqual(board(clone.db), first);
    assert.equal(clone.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, 1);
  } finally {
    origin.cleanup();
    clone.cleanup();
  }
});
