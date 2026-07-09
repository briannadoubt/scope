import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ulid,
  makeEvent,
  validateEvent,
  compareEvents,
  EVENT_KINDS,
  EVENT_FORMAT_VERSION,
  EventValidationError,
} from '../src/event-schema.js';

/* ---------------- ulid ---------------- */

test('ulid is 26 chars and lexicographically time-sortable', () => {
  const early = ulid(1_000);
  const late = ulid(2_000);
  assert.equal(early.length, 26);
  assert.equal(late.length, 26);
  assert.ok(early < late, 'later timestamp sorts after earlier');
});

test('ulid is monotonic within the same millisecond', () => {
  const a = ulid(5_000);
  const b = ulid(5_000);
  const c = ulid(5_000);
  assert.ok(a < b && b < c, 'same-ms ulids increment so they still sort in creation order');
});

/* ---------------- makeEvent ---------------- */

test('makeEvent builds a valid envelope with all required fields', () => {
  const e = makeEvent(
    'ticket.create',
    {
      ticketId: '01JZ9F2K7QABCD3EFGH4JKMN5',
      number: 42,
      keyPrefix: 'SCP',
      ticketType: 'story',
      title: 'OAuth login',
      description: '',
      status: 'backlog',
      priority: 'medium',
      parentId: '01JZ9F2K6PARENT00000000000',
      branch: null,
      prUrl: null,
      assignee: null,
      labels: [],
    },
    { actor: 'bri', ts: '2026-06-02T17:00:00.000Z' }
  );
  assert.equal(e.v, EVENT_FORMAT_VERSION);
  assert.equal(e.kind, 'ticket.create');
  assert.equal(e.actor, 'bri');
  assert.equal(e.ts, '2026-06-02T17:00:00.000Z');
  assert.equal(e.id.length, 26);
});

/* ---------------- validation ---------------- */

test('validateEvent accepts each well-formed kind', () => {
  const actor = 'agent';
  const good = [
    ['workspace.init', { key: 'SCP', name: 'Scope' }],
    ['workspace.set', { description: 'blurb' }],
    ['ticket.set_field', { ticketId: 'SCP-1', field: 'status', value: 'done' }],
    ['ticket.delete', { ticketId: 'SCP-1' }],
    ['comment.add', { ticketId: 'SCP-1', commentId: ulid(), author: 'bri', body: 'hi' }],
    ['relation.add', { fromId: 'SCP-1', toId: 'SCP-2', type: 'blocks' }],
    ['relation.remove', { fromId: 'SCP-1', toId: 'SCP-2', type: 'blocks' }],
  ];
  for (const [kind, payload] of good) {
    assert.doesNotThrow(() => makeEvent(kind, payload, { actor }), `${kind} should be valid`);
  }
});

test('validateEvent rejects malformed events', () => {
  const t = (fn, label) =>
    assert.throws(fn, EventValidationError, label);

  // bad status id shape; actual status membership is workspace-specific.
  t(() => makeEvent('ticket.set_field', { ticketId: 'X', field: 'status', value: 'Bad Status' }, { actor: 'a' }),
    'invalid status id shape');
  // missing actor
  t(() => makeEvent('ticket.delete', { ticketId: 'X' }, {}), 'missing actor');
  // unknown kind
  t(() => validateEvent({ v: 1, id: ulid(), ts: new Date().toISOString(), actor: 'a', kind: 'nope', payload: {} }),
    'unknown kind');
  // unsupported future version
  t(() => validateEvent({ v: 99, id: ulid(), ts: new Date().toISOString(), actor: 'a', kind: 'ticket.delete', payload: { ticketId: 'X' } }),
    'future version');
  // self-relation
  t(() => makeEvent('relation.add', { fromId: 'A', toId: 'A', type: 'blocks' }, { actor: 'a' }),
    'self relation');
  // set_field on unknown field
  t(() => makeEvent('ticket.set_field', { ticketId: 'X', field: 'nope', value: '1' }, { actor: 'a' }),
    'unknown field');
  // labels must be an array
  t(() => makeEvent('ticket.set_field', { ticketId: 'X', field: 'labels', value: 'not-array' }, { actor: 'a' }),
    'labels not array');
});

/* ---------------- canonical order ---------------- */

test('compareEvents is a deterministic total order: ts, then ulid id', () => {
  const x = { ts: '2026-01-01T00:00:00.000Z', actor: 'b', id: '2' };
  const y = { ts: '2026-01-01T00:00:00.000Z', actor: 'a', id: '9' };
  const z = { ts: '2026-01-02T00:00:00.000Z', actor: 'a', id: '1' };
  // Same ts -> id decides (creation order), NOT actor: x(id 2) before y(id 9).
  // z is last (later ts).
  assert.deepEqual([x, y, z].sort(compareEvents).map((e) => e.id), ['2', '9', '1']);
  // shuffling the input yields the same order
  assert.deepEqual([z, y, x].sort(compareEvents).map((e) => e.id), ['2', '9', '1']);
});

test('EVENT_KINDS is the closed set the validator switches on', () => {
  assert.equal(EVENT_KINDS.length, 9);
  assert.ok(EVENT_KINDS.includes('ticket.set_field'));
  assert.ok(EVENT_KINDS.includes('workspace.rekey'));
});
