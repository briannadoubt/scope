import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { openDb } from '../src/db.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { replayInto } from '../src/replay.js';
import { makeEvent } from '../src/event-schema.js';
import {
  createTicket,
  updateTicket,
  deleteTicket,
  addRelation,
  addComment,
  updateWorkspace,
  listTickets,
  listRelations,
  listComments,
} from '../src/repo.js';

/** A board snapshot that ignores volatile timestamps. */
function snapshot(db) {
  const tickets = listTickets(db).map((t) => ({
    id: t.id,
    uid: t.uid,
    number: t.number,
    type: t.type,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    parent_id: t.parent_id,
    branch: t.branch,
    pr_url: t.pr_url,
    assignee: t.assignee,
    labels: t.labels,
  }));
  const relations = tickets.flatMap((t) =>
    listRelations(db, t.id).map((r) => ({ from: t.id, to: r.to_ticket_id, type: r.type }))
  );
  const comments = tickets.flatMap((t) =>
    listComments(db, t.id).map((c) => ({ ticket: t.id, author: c.author, body: c.body }))
  );
  return { tickets, relations, comments };
}

test('round-trip: delete the db, replay the log, get an identical board', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    // Exercise every mutation kind.
    updateWorkspace(db, { name: 'Demo', description: 'a demo workspace' }, 'bri');
    const epic = createTicket(db, { type: 'epic', title: 'Auth', priority: 'high', actor: 'bri' });
    const a = createTicket(db, { type: 'story', title: 'Login', parent: epic.id, actor: 'bri' });
    const b = createTicket(db, { type: 'story', title: 'Logout', parent: epic.id, actor: 'bri' });
    const doomed = createTicket(db, { type: 'bug', title: 'Typo', actor: 'bri' });

    updateTicket(db, a.id, { status: 'in_progress', assignee: 'bri', labels: ['ui', 'p1'] }, 'bri');
    updateTicket(db, b.id, { status: 'done', branch: 'feat/logout' }, 'bri');
    addRelation(db, a.id, b.id, 'blocks', 'bri');
    addComment(db, a.id, 'started this', 'bri');
    addComment(db, a.id, 'nearly there', 'agent');
    deleteTicket(db, doomed.id, 'bri');

    const before = snapshot(db);

    // Capture the log, then nuke the materialized db entirely.
    const events = readAllEvents(eventsDir(scopeDir));
    db.exec('DELETE FROM tickets; DELETE FROM ticket_relations; DELETE FROM ticket_comments; DELETE FROM ticket_history;');
    assert.equal(listTickets(db).length, 0, 'db wiped');

    // Rebuild purely from events.
    const { applied } = replayInto(db, events);
    assert.ok(applied >= events.length - 1);

    const after = snapshot(db);
    assert.deepEqual(after, before, 'replayed board matches the original');
    // The deleted ticket stays deleted (terminal tombstone).
    assert.ok(!after.tickets.some((t) => t.title === 'Typo'));
  } finally {
    cleanup();
  }
});

test('replay is order-independent: shuffled event input projects the same board', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const a = createTicket(db, { type: 'story', title: 'A', actor: 'x' });
    const b = createTicket(db, { type: 'story', title: 'B', actor: 'y' });
    updateTicket(db, a.id, { status: 'done' }, 'x');
    addRelation(db, a.id, b.id, 'relates_to', 'x');
    const events = readAllEvents(eventsDir(scopeDir));

    const reference = (() => {
      const t = createTempScope();
      try {
        replayInto(t.db, events);
        return JSON.stringify(snapshot(t.db));
      } finally {
        t.cleanup();
      }
    })();

    // Reverse and a rotation — replayInto sorts internally, so result is stable.
    for (const perm of [[...events].reverse(), [...events.slice(2), ...events.slice(0, 2)]]) {
      const t = createTempScope();
      try {
        replayInto(t.db, perm);
        assert.equal(JSON.stringify(snapshot(t.db)), reference);
      } finally {
        t.cleanup();
      }
    }
  } finally {
    cleanup();
  }
});

test('last-writer-wins: the canonically-latest set_field decides the value', () => {
  const { db, cleanup } = createTempScope();
  try {
    // Two creates with the same requested number from different "peers".
    const c = makeEvent(
      'ticket.create',
      { ticketId: 'U1', number: 1, keyPrefix: 'SCP', ticketType: 'story', title: 'T', description: '', status: 'backlog', priority: 'medium', parentId: null, branch: null, prUrl: null, assignee: null, labels: [] },
      { actor: 'a', ts: '2026-01-01T00:00:00.000Z' }
    );
    const older = makeEvent('ticket.set_field', { ticketId: 'U1', field: 'status', value: 'todo' }, { actor: 'a', ts: '2026-01-02T00:00:00.000Z' });
    const newer = makeEvent('ticket.set_field', { ticketId: 'U1', field: 'status', value: 'done' }, { actor: 'a', ts: '2026-01-03T00:00:00.000Z' });

    replayInto(db, [newer, c, older]); // deliberately out of order
    const [t] = listTickets(db);
    assert.equal(t.status, 'done', 'latest ts wins regardless of input order');
  } finally {
    cleanup();
  }
});
