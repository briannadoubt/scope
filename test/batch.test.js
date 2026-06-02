import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { getMeta } from '../src/db.js';
import {
  applyBatch,
  createTicket,
  listTickets,
  listRelations,
  getTicket,
} from '../src/repo.js';

test('applyBatch creates an epic and its children atomically, resolving $refs', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const r = applyBatch(db, [
      { op: 'create', ref: 'epic', type: 'epic', title: 'Auth' },
      { op: 'create', type: 'story', title: 'Login', parent: '$epic' },
      { op: 'create', ref: 's2', type: 'story', title: 'Logout', parent: '$epic' },
      { op: 'link', from: '$s2', type: 'blocks', to: '$epic' },
    ], { actor: 'bri' });

    assert.equal(r.applied, 4);
    const tickets = listTickets(db);
    assert.equal(tickets.length, 3);
    const epic = tickets.find((t) => t.title === 'Auth');
    const login = tickets.find((t) => t.title === 'Login');
    assert.equal(login.parent_id, epic.id, '$epic resolved to the created epic id');
    assert.ok(listRelations(db, r.refs.s2).some((x) => x.type === 'blocks'));
  } finally {
    cleanup();
  }
});

test('applyBatch is atomic: a failing op rolls back the whole batch (db AND log)', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const existing = createTicket(db, { type: 'story', title: 'Pre-existing' });
    const eventsBefore = readAllEvents(eventsDir(scopeDir)).length;
    const appliedBefore = Number(getMeta(db, 'applied_event_count'));

    assert.throws(() =>
      applyBatch(db, [
        { op: 'create', type: 'story', title: 'Should not survive' },
        { op: 'status', id: existing.id, status: 'done' },
        { op: 'update', id: 'SCP-9999', fields: { status: 'done' } }, // fails: missing ticket
      ], { actor: 'bri' })
    );

    // Nothing from the batch persisted: no new ticket, original unchanged...
    assert.equal(listTickets(db).length, 1, 'no partial ticket created');
    assert.equal(getTicket(db, existing.id).status, 'backlog', 'status change rolled back');
    // ...and no events were written.
    assert.equal(readAllEvents(eventsDir(scopeDir)).length, eventsBefore, 'no events written on rollback');
    assert.equal(Number(getMeta(db, 'applied_event_count')), appliedBefore, 'applied count unchanged');
  } finally {
    cleanup();
  }
});

test('applyBatch writes exactly one event per emitting op on success', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const before = readAllEvents(eventsDir(scopeDir)).length;
    applyBatch(db, [
      { op: 'create', type: 'bug', title: 'A' },
      { op: 'create', type: 'bug', title: 'B' },
    ], { actor: 'bri' });
    const after = readAllEvents(eventsDir(scopeDir)).length;
    assert.equal(after - before, 2, 'two ticket.create events written');
    assert.equal(Number(getMeta(db, 'applied_event_count')), after, 'applied count matches file count');
  } finally {
    cleanup();
  }
});

test('applyBatch rejects unknown ops and bad refs (before any write)', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const before = readAllEvents(eventsDir(scopeDir)).length;
    assert.throws(() => applyBatch(db, [{ op: 'frobnicate' }]), /unknown op/);
    assert.throws(() => applyBatch(db, [{ op: 'create', type: 'story', title: 'X', parent: '$nope' }]), /unknown ref/);
    assert.equal(readAllEvents(eventsDir(scopeDir)).length, before, 'no events from failed batches');
  } finally {
    cleanup();
  }
});
