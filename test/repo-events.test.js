import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import {
  createTicket,
  updateTicket,
  deleteTicket,
  addRelation,
  removeRelation,
  addComment,
  updateWorkspace,
} from '../src/repo.js';

/** All events emitted into a temp workspace, in canonical order. */
function events(scopeDir) {
  return readAllEvents(eventsDir(scopeDir));
}
const kinds = (scopeDir) => events(scopeDir).map((e) => e.kind);

test('createTicket emits a ticket.create with a ULID id, number and keyPrefix', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'story', title: 'Hello', actor: 'bri' });
    const evs = events(scopeDir);
    assert.equal(evs.length, 1);
    const e = evs[0];
    assert.equal(e.kind, 'ticket.create');
    assert.equal(e.actor, 'bri');
    assert.equal(e.payload.ticketId, t.uid);
    assert.equal(e.payload.ticketId.length, 26, 'ticketId is a ULID');
    assert.equal(e.payload.number, t.number);
    assert.match(e.payload.keyPrefix, /^[A-Z][A-Z0-9]{1,9}$/);
    assert.equal(e.payload.title, 'Hello');
  } finally {
    cleanup();
  }
});

test('child ticket.create references its parent by ULID, not KEY-N', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const epic = createTicket(db, { type: 'epic', title: 'Epic' });
    const story = createTicket(db, { type: 'story', title: 'Story', parent: epic.id });
    const createEvents = events(scopeDir).filter((e) => e.kind === 'ticket.create');
    const childCreate = createEvents.find((e) => e.payload.ticketId === story.uid);
    assert.equal(childCreate.payload.parentId, epic.uid);
  } finally {
    cleanup();
  }
});

test('updateTicket emits one ticket.set_field per changed field (camelCase, parent as ULID)', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const epic = createTicket(db, { type: 'epic', title: 'E' });
    const t = createTicket(db, { type: 'story', title: 'T' });
    updateTicket(db, t.id, { status: 'in_progress', pr_url: 'https://x/pr/1', parent_id: epic.id }, 'bri');

    const sets = events(scopeDir).filter((e) => e.kind === 'ticket.set_field');
    const byField = Object.fromEntries(sets.map((e) => [e.payload.field, e.payload]));
    assert.equal(byField.status.value, 'in_progress');
    assert.equal(byField.prUrl.value, 'https://x/pr/1', 'pr_url column -> prUrl field');
    assert.equal(byField.parentId.value, epic.uid, 'parent_id value is the parent ULID');
    assert.ok(sets.every((e) => e.payload.ticketId === t.uid));
  } finally {
    cleanup();
  }
});

test('labels set_field carries an array, not a JSON string', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'bug', title: 'B' });
    updateTicket(db, t.id, { labels: ['a', 'b'] }, 'bri');
    const e = events(scopeDir).find((x) => x.kind === 'ticket.set_field' && x.payload.field === 'labels');
    assert.deepEqual(e.payload.value, ['a', 'b']);
  } finally {
    cleanup();
  }
});

test('relations, comments, deletes, and workspace edits all emit their event kinds', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const a = createTicket(db, { type: 'story', title: 'A' });
    const b = createTicket(db, { type: 'story', title: 'B' });

    addRelation(db, a.id, b.id, 'blocks', 'bri');
    const relAdd = events(scopeDir).find((e) => e.kind === 'relation.add');
    assert.deepEqual(
      { from: relAdd.payload.fromId, to: relAdd.payload.toId, type: relAdd.payload.type },
      { from: a.uid, to: b.uid, type: 'blocks' }
    );

    removeRelation(db, a.id, b.id, 'blocks', 'bri');
    assert.ok(events(scopeDir).some((e) => e.kind === 'relation.remove'));

    addComment(db, a.id, 'a note', 'bri');
    const comment = events(scopeDir).find((e) => e.kind === 'comment.add');
    assert.equal(comment.payload.ticketId, a.uid);
    assert.equal(comment.payload.commentId.length, 26, 'commentId is a ULID');
    assert.equal(comment.payload.body, 'a note');

    deleteTicket(db, b.id, 'bri');
    const del = events(scopeDir).find((e) => e.kind === 'ticket.delete');
    assert.equal(del.payload.ticketId, b.uid);

    updateWorkspace(db, { description: 'new blurb' }, 'bri');
    const wsSet = events(scopeDir).find((e) => e.kind === 'workspace.set');
    assert.equal(wsSet.payload.description, 'new blurb');
  } finally {
    cleanup();
  }
});

test('every emitted event passes validation (readAllEvents is strict)', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'story', title: 'T', actor: 'bri' });
    updateTicket(db, t.id, { status: 'done' }, 'bri');
    addComment(db, t.id, 'done!', 'bri');
    // readAllEvents validates each file; throwing here would mean a bad event.
    const evs = events(scopeDir);
    assert.ok(evs.length >= 3);
    assert.ok(evs.every((e) => typeof e.actor === 'string' && e.actor.length > 0));
  } finally {
    cleanup();
  }
});
