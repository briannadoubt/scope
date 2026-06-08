import test from 'node:test';
import assert from 'node:assert/strict';

import { isTailAppend, canonicalMax } from '../src/pg/incremental.js';

/**
 * SCP-143 — pure tail-append decision helper. No Postgres needed; this is the
 * cheap, deterministic gate that decides whether an upload batch can be applied
 * incrementally (true) or requires a full tenant-scoped replay (false).
 *
 * Canonical order is (ts, id) per compareEvents.
 */

const e = (ts, id) => ({ ts, id });

test('empty batch is trivially a tail-append', () => {
  assert.equal(isTailAppend(e('2026-01-01T00:00:00.000Z', '01A'), []), true);
  assert.equal(isTailAppend(null, []), true);
});

test('empty existing log: any first batch is a clean append from empty', () => {
  assert.equal(isTailAppend(null, [e('2026-01-01T00:00:00.000Z', '01A')]), true);
  assert.equal(
    isTailAppend(null, [e('2026-01-02T00:00:00.000Z', '02B'), e('2026-01-01T00:00:00.000Z', '01A')]),
    true
  );
});

test('batch strictly after existing max is a tail-append (ts dominates)', () => {
  const max = e('2026-06-07T10:00:00.000Z', '01HZA');
  assert.equal(isTailAppend(max, [e('2026-06-07T10:00:01.000Z', '01HZB')]), true);
  assert.equal(
    isTailAppend(max, [
      e('2026-06-07T11:00:00.000Z', '01HZC'),
      e('2026-06-07T12:00:00.000Z', '01HZD'),
    ]),
    true
  );
});

test('tie on ts is broken by id: greater id is after, equal/lesser is NOT', () => {
  const max = e('2026-06-07T10:00:00.000Z', '01HZM');
  assert.equal(isTailAppend(max, [e('2026-06-07T10:00:00.000Z', '01HZN')]), true, 'same ts, larger id => after');
  assert.equal(isTailAppend(max, [e('2026-06-07T10:00:00.000Z', '01HZM')]), false, 'equal event => not strictly after');
  assert.equal(isTailAppend(max, [e('2026-06-07T10:00:00.000Z', '01HZA')]), false, 'same ts, smaller id => before');
});

test('an event landing before/at the max forces full replay (false)', () => {
  const max = e('2026-06-07T10:00:00.000Z', '01HZM');
  // One late-arriving (out-of-order) event among otherwise-newer ones fails it.
  assert.equal(
    isTailAppend(max, [
      e('2026-06-07T11:00:00.000Z', '01HZP'),
      e('2026-06-07T09:00:00.000Z', '01HZB'), // earlier ts: inserts into history
    ]),
    false
  );
});

test('canonicalMax returns the (ts,id)-greatest event, or null when empty', () => {
  assert.equal(canonicalMax([]), null);
  assert.deepEqual(
    canonicalMax([
      e('2026-06-07T10:00:00.000Z', '01A'),
      e('2026-06-07T12:00:00.000Z', '01B'),
      e('2026-06-07T11:00:00.000Z', '01C'),
    ]),
    { ts: '2026-06-07T12:00:00.000Z', id: '01B' }
  );
  // Tie on ts -> larger id wins.
  assert.deepEqual(
    canonicalMax([e('2026-06-07T10:00:00.000Z', '01A'), e('2026-06-07T10:00:00.000Z', '01Z')]),
    { ts: '2026-06-07T10:00:00.000Z', id: '01Z' }
  );
});

test('canonicalMax output feeds isTailAppend correctly', () => {
  const existing = [e('2026-06-07T10:00:00.000Z', '01A'), e('2026-06-07T11:00:00.000Z', '01B')];
  const max = canonicalMax(existing);
  assert.equal(isTailAppend(max, [e('2026-06-07T12:00:00.000Z', '01C')]), true);
  assert.equal(isTailAppend(max, [e('2026-06-07T10:30:00.000Z', '01D')]), false);
});
