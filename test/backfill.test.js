import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import { createTempScope } from './helpers.js';
import { openDb } from '../src/db.js';
import { backfillEvents, ensureEventLog } from '../src/backfill.js';
import { readAllEvents, eventsDir, logHasInit, appendEvent } from '../src/event-store.js';
import { makeEvent } from '../src/event-schema.js';
import { replayInto, syncFromLog } from '../src/replay.js';
import {
  createTicket,
  updateTicket,
  addRelation,
  addComment,
  listTickets,
  listRelations,
  listComments,
  listHistory,
} from '../src/repo.js';

function board(db) {
  const tickets = listTickets(db).map((t) => ({
    id: t.id, uid: t.uid, number: t.number, type: t.type, title: t.title,
    description: t.description, status: t.status, priority: t.priority,
    parent_id: t.parent_id, branch: t.branch, pr_url: t.pr_url,
    assignee: t.assignee, labels: t.labels,
  }));
  const relations = tickets.flatMap((t) =>
    listRelations(db, t.id).map((r) => ({ from: t.id, to: r.to_ticket_id, type: r.type }))
  );
  const comments = tickets.flatMap((t) =>
    listComments(db, t.id).map((c) => ({ ticket: t.id, author: c.author, body: c.body }))
  );
  return { tickets, relations, comments };
}

test('backfill reconstructs a log whose replay reproduces the current board', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    // Build realistic state THROUGH repo (which also creates events)...
    const epic = createTicket(db, { type: 'epic', title: 'Platform', priority: 'high' });
    const a = createTicket(db, { type: 'story', title: 'API', parent: epic.id });
    const b = createTicket(db, { type: 'story', title: 'DB', parent: epic.id });
    updateTicket(db, a.id, { status: 'in_progress', assignee: 'bri', labels: ['x'] }, 'bri');
    updateTicket(db, a.id, { status: 'done' }, 'bri'); // two changes -> history walk
    addRelation(db, a.id, b.id, 'blocks', 'bri');
    addComment(db, a.id, 'shipping', 'bri');

    const expected = board(db);

    // ...then DISCARD the real event log to simulate a pre-event-sourcing DB.
    rmSync(eventsDir(scopeDir), { recursive: true, force: true });
    assert.equal(logHasInit(eventsDir(scopeDir)), false);

    // Backfill purely from DB rows + history.
    const { written } = backfillEvents(db, scopeDir);
    assert.ok(written > 0);

    // Replay the synthesized log into a clean DB and compare.
    const fresh = createTempScope();
    try {
      replayInto(fresh.db, readAllEvents(eventsDir(scopeDir)));
      assert.deepEqual(board(fresh.db), expected, 'replayed backfill matches original board');
    } finally {
      fresh.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('backfill preserves the audit trail (history walk via initial-state + set_field)', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'bug', title: 'Crash' });
    updateTicket(db, t.id, { status: 'todo' }, 'bri');
    updateTicket(db, t.id, { status: 'in_progress' }, 'bri');
    updateTicket(db, t.id, { status: 'done' }, 'agent');
    rmSync(eventsDir(scopeDir), { recursive: true, force: true });
    backfillEvents(db, scopeDir);

    const fresh = createTempScope();
    try {
      replayInto(fresh.db, readAllEvents(eventsDir(scopeDir)));
      const [rt] = listTickets(fresh.db);
      assert.equal(rt.status, 'done', 'walks history to current value');
      const statusChanges = listHistory(fresh.db, rt.id).filter((h) => h.field === 'status');
      assert.ok(statusChanges.length >= 3, 'history reconstructed from set_field events');
    } finally {
      fresh.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('backfill reconciles a current value that history does not end on', () => {
  // Mirrors a real board (One/RT-40): an older code path set status without
  // recording history, so ticket_history ends at in_progress but the row is done.
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'story', title: 'T' });
    updateTicket(db, t.id, { status: 'in_progress' }, 'bri'); // logged to history
    // Simulate a status change with NO history row (direct write).
    db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run('done', t.id);

    rmSync(eventsDir(scopeDir), { recursive: true, force: true });
    backfillEvents(db, scopeDir);

    const fresh = createTempScope();
    try {
      replayInto(fresh.db, readAllEvents(eventsDir(scopeDir)));
      assert.equal(listTickets(fresh.db)[0].status, 'done', 'replay reproduces the CURRENT value');
    } finally {
      fresh.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('ensureEventLog backfills once, then is idempotent (authority = workspace.init)', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    createTicket(db, { type: 'story', title: 'T' }); // partial events, not yet authoritative
    assert.equal(logHasInit(eventsDir(scopeDir)), false);

    const first = ensureEventLog(db, scopeDir); // bootstraps a complete log
    assert.equal(first.skipped, false);
    assert.equal(logHasInit(eventsDir(scopeDir)), true, 'log now authoritative');
    const count = readAllEvents(eventsDir(scopeDir)).length;

    const second = ensureEventLog(db, scopeDir); // no-op now
    assert.equal(second.skipped, true);
    assert.equal(readAllEvents(eventsDir(scopeDir)).length, count, 'no duplicate events written');
  } finally {
    cleanup();
  }
});

test('REGRESSION: a populated db with a partial (non-authoritative) log is never wiped by sync', () => {
  // Reproduces the data-loss incident: stray set_field events with no
  // workspace.init existed alongside a full db. syncFromLog must NOT rebuild
  // from such a partial log; ensureEventLog must backfill a complete one.
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'story', title: 'Precious' });
    updateTicket(db, t.id, { status: 'done' }, 'bri');

    // Replace the log with ONLY a partial set_field event (no init, no create).
    rmSync(eventsDir(scopeDir), { recursive: true, force: true });
    appendEvent(
      eventsDir(scopeDir),
      makeEvent('ticket.set_field', { ticketId: t.uid, field: 'status', value: 'todo' }, { actor: 'x' })
    );
    assert.equal(logHasInit(eventsDir(scopeDir)), false, 'log is not authoritative');

    // The disaster step: sync must refuse to rebuild from the partial log.
    const sync1 = syncFromLog(db, scopeDir);
    assert.equal(sync1.rebuilt, false);
    assert.equal(listTickets(db).length, 1, 'db NOT wiped');
    assert.equal(listTickets(db)[0].title, 'Precious');

    // ensureEventLog bootstraps a complete, authoritative log from the db.
    const r = ensureEventLog(db, scopeDir);
    assert.equal(r.skipped, false);
    assert.equal(logHasInit(eventsDir(scopeDir)), true);

    // And now sync is a safe no-op (db already matches).
    assert.equal(syncFromLog(db, scopeDir).rebuilt, false);
    assert.equal(listTickets(db)[0].status, 'done', 'db state preserved throughout');
  } finally {
    cleanup();
  }
});

test('backfill on an empty workspace emits just workspace.init', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    rmSync(eventsDir(scopeDir), { recursive: true, force: true });
    backfillEvents(db, scopeDir);
    const evs = readAllEvents(eventsDir(scopeDir));
    assert.equal(evs.length, 1);
    assert.equal(evs[0].kind, 'workspace.init');
  } finally {
    cleanup();
  }
});
