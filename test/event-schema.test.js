import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ulid,
  makeEvent,
  validateEvent,
  compareEvents,
  EVENT_KINDS,
  EVENT_FORMAT_VERSION,
  MINIMUM_READER_EVENT_FORMAT_VERSION,
  SUPPORTED_EVENT_FORMAT_VERSIONS,
  EventValidationError,
  UnsupportedEventVersionError,
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
    { actor: 'bri', ts: '2026-06-02T17:00:00.000Z', requestId: 'req-1', requestCommand: 'ticket create' }
  );
  assert.equal(e.v, EVENT_FORMAT_VERSION);
  assert.equal(e.kind, 'ticket.create');
  assert.equal(e.actor, 'bri');
  assert.equal(e.ts, '2026-06-02T17:00:00.000Z');
  assert.equal(e.id.length, 26);
  assert.equal(e.requestId, 'req-1');
  assert.equal(e.v, 2, 'new writes declare the expanded reader contract');
});

test('reader accepts immutable v1 history while the writer emits v2', () => {
  const legacy = makeEvent('ticket.delete', { ticketId: 'SCP-1' }, { actor: 'legacy' });
  legacy.v = 1;
  assert.doesNotThrow(() => validateEvent(legacy));
  assert.deepEqual(SUPPORTED_EVENT_FORMAT_VERSIONS, [1, 2]);
  assert.equal(MINIMUM_READER_EVENT_FORMAT_VERSION, 2);
});

test('unsupported event versions fail with an actionable compatibility error', () => {
  const future = makeEvent('ticket.delete', { ticketId: 'SCP-1' }, { actor: 'future' });
  future.v = 3;
  assert.throws(
    () => validateEvent(future),
    (error) => {
      assert.ok(error instanceof UnsupportedEventVersionError);
      assert.equal(error.code, 'UNSUPPORTED_EVENT_FORMAT');
      assert.equal(error.version, 3);
      assert.deepEqual(error.supportedVersions, [1, 2]);
      assert.match(error.message, /Upgrade Scope before opening or syncing/);
      return true;
    }
  );
});

/* ---------------- validation ---------------- */

test('validateEvent accepts each well-formed kind', () => {
  const actor = 'agent';
  const txA = ulid();
  const txB = ulid();
  const good = [
    ['transaction.commit', { transactionId: ulid(), eventIds: [txA, txB] }],
    ['workspace.init', { key: 'SCP', name: 'Scope' }],
    ['workspace.set', { description: 'blurb' }],
    ['ticket.set_field', { ticketId: 'SCP-1', field: 'status', value: 'done' }],
    ['ticket.delete', { ticketId: 'SCP-1' }],
    ['comment.add', { ticketId: 'SCP-1', commentId: ulid(), author: 'bri', body: 'hi' }],
    ['artifact.put', { ticketId: 'SCP-1', artifactId: ulid(), name: 'chart.html', mimeType: 'text/html', content: '<h1>Chart</h1>' }],
    ['artifact.remove', { ticketId: 'SCP-1', artifactId: ulid() }],
    ['relation.add', { fromId: 'SCP-1', toId: 'SCP-2', type: 'blocks' }],
    ['relation.remove', { fromId: 'SCP-1', toId: 'SCP-2', type: 'blocks' }],
    ['agent.register', { agentId: 'codex:sol', displayName: 'Sol', provider: 'openai', capabilities: [], metadata: {}, status: 'online', registeredAt: '2026-08-23T00:00:00Z', seenAt: '2026-08-23T00:00:00Z', expiresAt: '2026-08-23T00:02:00Z' }],
    ['agent.heartbeat', { agentId: 'codex:sol', capabilities: [], metadata: {}, status: 'busy', seenAt: '2026-08-23T00:01:00Z', expiresAt: '2026-08-23T00:03:00Z' }],
    ['agent.message.send', { messageId: ulid(), ticketId: null, fromAgent: 'codex:sol', toAgent: 'claude:opus', kind: 'question', body: 'Can you review this?', artifactRefs: [], threadId: ulid(), replyTo: null, correlationId: null, createdAt: '2026-08-23T00:00:00Z', expiresAt: null }],
    ['agent.message.ack', { messageId: ulid(), agent: 'claude:opus', acknowledgedAt: '2026-08-23T00:01:00Z' }],
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
  // missing/malformed versions are corrupt envelopes, not future formats
  t(() => validateEvent({ id: ulid(), ts: new Date().toISOString(), actor: 'a', kind: 'ticket.delete', payload: { ticketId: 'X' } }),
    'missing version');
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
  assert.equal(EVENT_KINDS.length, 25);
  assert.ok(EVENT_KINDS.includes('transaction.commit'));
  assert.ok(EVENT_KINDS.includes('ticket.set_field'));
  assert.ok(EVENT_KINDS.includes('workspace.rekey'));
  assert.ok(EVENT_KINDS.includes('artifact.put'));
  assert.ok(EVENT_KINDS.includes('artifact.remove'));
  assert.ok(EVENT_KINDS.includes('agent.lease.claim'));
  assert.ok(EVENT_KINDS.includes('agent.attempt.finish'));
  assert.ok(EVENT_KINDS.includes('agent.message.send'));
  assert.ok(EVENT_KINDS.includes('agent.message.ack'));
});
