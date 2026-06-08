import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { updateWorkspace, createTicket, updateTicket, addComment } from '../src/repo.js';
import { replayInto } from '../src/replay.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { makeEvent, validateEvent, formatActor, EventValidationError } from '../src/event-schema.js';

/**
 * SCP-128 — event attribution model. The event log keeps `actor` (the human
 * principal) and an optional `model` (the acting agent) separate; the derived
 * cache renders "{model} on behalf of {actor}" so every history/UI surface
 * shows attribution. With no model, behavior is byte-identical to before.
 */

function setup() {
  const s = createTempScope();
  // Pin a valid workspace key so the ticket.create keyPrefix is deterministic.
  updateWorkspace(s.db, { key: 'TST', name: 'Test' }, 'setup');
  return s;
}

const lastHistory = (db) =>
  db.prepare('SELECT changed_by FROM ticket_history ORDER BY id DESC LIMIT 1').get();

test('no model: event omits the field and history shows the bare principal', () => {
  const { scopeDir, db, cleanup } = setup();
  try {
    const t = createTicket(db, { type: 'story', title: 'Hello', actor: 'bri' });
    updateTicket(db, t.id, { status: 'in_progress' }, 'bri');
    const setEvt = readAllEvents(eventsDir(scopeDir)).find((e) => e.kind === 'ticket.set_field');
    assert.equal('model' in setEvt, false, 'envelope omits model entirely when absent');
    assert.equal(lastHistory(db).changed_by, 'bri');
  } finally {
    cleanup();
  }
});

test('with model: event keeps actor+model separate; history renders attribution', () => {
  const { scopeDir, db, cleanup } = setup();
  try {
    const t = createTicket(db, { type: 'story', title: 'Hello', actor: 'bri' });
    updateTicket(db, t.id, { status: 'in_review' }, 'bri', 'Opus 4.8');
    const setEvt = readAllEvents(eventsDir(scopeDir)).filter((e) => e.kind === 'ticket.set_field').at(-1);
    assert.equal(setEvt.actor, 'bri', 'principal is the human');
    assert.equal(setEvt.model, 'Opus 4.8', 'envelope carries the acting model');
    assert.equal(lastHistory(db).changed_by, 'Opus 4.8 on behalf of bri');
  } finally {
    cleanup();
  }
});

test('attribution survives a full log -> replay round-trip (source of truth)', () => {
  const { scopeDir, db, cleanup } = setup();
  try {
    const t = createTicket(db, { type: 'story', title: 'Hello', actor: 'bri' });
    updateTicket(db, t.id, { status: 'in_progress' }, 'bri'); // bare
    updateTicket(db, t.id, { status: 'in_review' }, 'bri', 'Opus 4.8'); // attributed
    replayInto(db, readAllEvents(eventsDir(scopeDir)));
    const rows = db.prepare('SELECT changed_by FROM ticket_history ORDER BY id').all().map((r) => r.changed_by);
    assert.ok(rows.includes('bri'), 'bare-principal row reconstructed');
    assert.ok(rows.includes('Opus 4.8 on behalf of bri'), 'attribution reconstructed from the log alone');
  } finally {
    cleanup();
  }
});

test('comments attribute too; batch op-level model overrides the batch default', () => {
  const { db, cleanup } = setup();
  try {
    const t = createTicket(db, { type: 'story', title: 'Hello', actor: 'bri' });
    const c = addComment(db, t.id, 'looking into this', 'bri', 'Opus 4.8');
    assert.equal(c.author, 'Opus 4.8 on behalf of bri');
  } finally {
    cleanup();
  }
});

test('validateEvent: model is optional, rejected only when present-but-invalid', () => {
  const base = { ticketId: 'x'.repeat(26), field: 'status', value: 'todo' };
  assert.doesNotThrow(() => makeEvent('ticket.set_field', base, { actor: 'bri', model: 'Opus 4.8' }));
  assert.doesNotThrow(() => makeEvent('ticket.set_field', base, { actor: 'bri' }));
  assert.throws(
    () =>
      validateEvent({
        v: 1, id: 'i'.repeat(26), ts: new Date().toISOString(),
        actor: 'bri', model: 42, kind: 'ticket.delete', payload: { ticketId: 'y'.repeat(26) },
      }),
    EventValidationError
  );
  assert.equal(formatActor('bri', null), 'bri');
  assert.equal(formatActor('bri', 'Opus 4.8'), 'Opus 4.8 on behalf of bri');
});
