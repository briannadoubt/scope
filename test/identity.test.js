import test from 'node:test';
import assert from 'node:assert/strict';

import { makeEvent } from '../src/event-schema.js';
import { resolveDisplayNumbers, humanId, nextNumberSeed } from '../src/identity.js';

/** Build a ticket.create event with a given id/number/ts/actor. */
function create({ ticketId, number, ts, actor = 'a', keyPrefix = 'SCP' }) {
  return makeEvent(
    'ticket.create',
    {
      ticketId,
      number,
      keyPrefix,
      ticketType: 'story',
      title: `t${number}`,
      description: '',
      status: 'backlog',
      priority: 'medium',
      parentId: null,
      branch: null,
      prUrl: null,
      assignee: null,
      labels: [],
    },
    { actor, ts }
  );
}

test('humanId composes prefix and number', () => {
  assert.equal(humanId('SCP', 42), 'SCP-42');
});

test('non-colliding creates keep their requested numbers', () => {
  const events = [
    create({ ticketId: 'A', number: 1, ts: '2026-01-01T00:00:00.000Z' }),
    create({ ticketId: 'B', number: 2, ts: '2026-01-01T00:00:01.000Z' }),
    create({ ticketId: 'C', number: 3, ts: '2026-01-01T00:00:02.000Z' }),
  ];
  const { assignments, renumbered } = resolveDisplayNumbers(events);
  assert.equal(renumbered.length, 0);
  assert.equal(assignments.get('A').humanId, 'SCP-1');
  assert.equal(assignments.get('C').humanId, 'SCP-3');
});

test('on collision the canonically-earlier create keeps the number, the later is bumped', () => {
  // Two offline peers both minted SCP-7. Peer A's create has the earlier ts.
  const a = create({ ticketId: 'A-ulid', number: 7, ts: '2026-01-01T00:00:00.000Z', actor: 'alice' });
  const b = create({ ticketId: 'B-ulid', number: 7, ts: '2026-01-02T00:00:00.000Z', actor: 'bob' });
  const { assignments, renumbered } = resolveDisplayNumbers([a, b]);

  assert.equal(assignments.get('A-ulid').number, 7, 'earlier create keeps 7');
  assert.equal(assignments.get('B-ulid').number, 8, 'later create bumped to max+1');
  assert.deepEqual(renumbered, [{ ticketId: 'B-ulid', from: 7, to: 8 }]);
});

test('resolution is deterministic regardless of input order', () => {
  const a = create({ ticketId: 'A', number: 1, ts: '2026-01-01T00:00:00.000Z' });
  const b = create({ ticketId: 'B', number: 1, ts: '2026-01-01T00:00:05.000Z' });
  const c = create({ ticketId: 'C', number: 2, ts: '2026-01-01T00:00:03.000Z' });

  const orderings = [
    [a, b, c],
    [c, b, a],
    [b, c, a],
    [c, a, b],
  ];
  const results = orderings.map((evts) => {
    const { assignments } = resolveDisplayNumbers(evts);
    return [...assignments.entries()]
      .map(([id, v]) => `${id}:${v.number}`)
      .sort()
      .join(',');
  });
  // Every ordering must produce the identical assignment.
  assert.equal(new Set(results).size, 1, `divergent results: ${JSON.stringify(results)}`);
  // And specifically: A keeps 1 (earliest), C keeps 2, B bumped to 3 (max+1 at its turn).
  assert.equal(results[0], 'A:1,B:3,C:2');
});

test('nextNumberSeed is one past the highest assigned number', () => {
  const { assignments } = resolveDisplayNumbers([
    create({ ticketId: 'A', number: 7, ts: '2026-01-01T00:00:00.000Z' }),
    create({ ticketId: 'B', number: 7, ts: '2026-01-02T00:00:00.000Z' }), // -> 8
  ]);
  assert.equal(nextNumberSeed(assignments), 9);
});

test('non-create events are ignored by the resolver', () => {
  const c = create({ ticketId: 'A', number: 1, ts: '2026-01-01T00:00:00.000Z' });
  const setField = makeEvent(
    'ticket.set_field',
    { ticketId: 'A', field: 'status', value: 'done' },
    { actor: 'a', ts: '2026-01-01T00:00:01.000Z' }
  );
  const { assignments } = resolveDisplayNumbers([c, setField]);
  assert.equal(assignments.size, 1);
  assert.equal(assignments.get('A').number, 1);
});
