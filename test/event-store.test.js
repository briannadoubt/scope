import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendEvent,
  appendTransaction,
  committedEvents,
  inspectEventStore,
  readAllEvents,
  eventsDir,
} from '../src/event-store.js';
import { makeEvent, UnsupportedEventVersionError } from '../src/event-schema.js';

function tmpEventsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'scope-events-'));
  return { dir: eventsDir(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const evt = (kind, payload, ts) => makeEvent(kind, payload, { actor: 'tester', ts });

test('appendEvent writes one file per event named by id, and readAllEvents round-trips', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    const a = appendEvent(dir, evt('ticket.delete', { ticketId: 'X' }, '2026-01-01T00:00:00.000Z'));
    const b = appendEvent(dir, evt('ticket.delete', { ticketId: 'Y' }, '2026-01-01T00:00:01.000Z'));
    const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    assert.equal(files.length, 2);
    assert.ok(files.includes(`${a.id}.json`));
    assert.ok(files.includes(`${b.id}.json`));

    const all = readAllEvents(dir);
    assert.deepEqual(all.map((e) => e.payload.ticketId), ['X', 'Y']);
  } finally {
    cleanup();
  }
});

test('readAllEvents returns events in canonical order regardless of write order', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    appendEvent(dir, evt('ticket.delete', { ticketId: 'late' }, '2026-03-01T00:00:00.000Z'));
    appendEvent(dir, evt('ticket.delete', { ticketId: 'early' }, '2026-01-01T00:00:00.000Z'));
    const all = readAllEvents(dir);
    assert.deepEqual(all.map((e) => e.payload.ticketId), ['early', 'late']);
  } finally {
    cleanup();
  }
});

test('appendEvent rejects a malformed event before writing anything', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    assert.throws(() => appendEvent(dir, { v: 1, id: 'x', ts: 'nope', actor: 'a', kind: 'ticket.delete', payload: {} }));
    // nothing written
    assert.throws(() => readdirSync(dir), /ENOENT/); // dir not even created
  } finally {
    cleanup();
  }
});

test('appendEvent is idempotent but rejects an immutable-id collision', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    const event = evt('ticket.delete', { ticketId: 'A' }, '2026-01-01T00:00:00.000Z');
    appendEvent(dir, event);
    assert.deepEqual(appendEvent(dir, event), event);
    assert.throws(
      () => appendEvent(dir, { ...event, payload: { ticketId: 'B' } }),
      /immutable event differs/
    );
  } finally {
    cleanup();
  }
});

test('readAllEvents skips temp files and is strict about corrupt json by default', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    appendEvent(dir, evt('ticket.delete', { ticketId: 'ok' }, '2026-01-01T00:00:00.000Z'));
    writeFileSync(join(dir, '.partial.json.tmp'), '{ not done');
    // temp file ignored
    assert.equal(readAllEvents(dir).length, 1);
    // a real corrupt .json throws in strict mode, is skipped when tolerant
    writeFileSync(join(dir, 'corrupt.json'), '{ broken');
    assert.throws(() => readAllEvents(dir), /Corrupt event file/);
    assert.equal(readAllEvents(dir, { tolerant: true }).length, 1);
  } finally {
    cleanup();
  }
});

test('newer event formats are incompatible, never mislabeled or skipped as corruption', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    const future = evt('ticket.delete', { ticketId: 'future' }, '2026-01-01T00:00:00.000Z');
    future.v = 3;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${future.id}.json`), JSON.stringify(future));

    assert.throws(() => readAllEvents(dir), UnsupportedEventVersionError);
    assert.throws(
      () => readAllEvents(dir, { tolerant: true }),
      UnsupportedEventVersionError,
      'tolerant diagnostics must not silently project an incomplete future log'
    );

    const report = inspectEventStore(dir);
    assert.equal(report.ok, false);
    assert.equal(report.corruptFiles.length, 0);
    assert.equal(report.incompatibleFiles.length, 1);
    assert.equal(report.incompatibleFiles[0].version, 3);
    assert.deepEqual(report.incompatibleFiles[0].supportedVersions, [1, 2]);
  } finally {
    cleanup();
  }
});

test('readAllEvents on a missing dir returns []', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    assert.deepEqual(readAllEvents(dir), []);
  } finally {
    cleanup();
  }
});

test('transaction members stay invisible until the durable commit marker exists', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    const transactionId = makeEvent(
      'ticket.delete', { ticketId: 'seed' }, { actor: 'tester' }
    ).id;
    const a = makeEvent(
      'ticket.delete', { ticketId: 'A' },
      { actor: 'tester', transactionId, transactionIndex: 0 }
    );
    const b = makeEvent(
      'ticket.delete', { ticketId: 'B' },
      { actor: 'tester', transactionId, transactionIndex: 1 }
    );
    appendEvent(dir, a);
    appendEvent(dir, b);

    assert.deepEqual(readAllEvents(dir), [], 'uncommitted members are ignored');
    const report = inspectEventStore(dir);
    assert.equal(report.orphanTransactionEvents.length, 2);
    assert.equal(report.effectiveEvents, 0);
    assert.equal(report.ok, false, 'doctor must surface invisible orphan members');
  } finally {
    cleanup();
  }
});

test('appendTransaction exposes all members and its commit atomically to readers', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    const a = evt('ticket.delete', { ticketId: 'A' }, '2026-01-01T00:00:00.000Z');
    const b = evt('ticket.delete', { ticketId: 'B' }, '2026-01-01T00:00:01.000Z');
    const receipt = appendTransaction(dir, [a, b]);
    const all = readAllEvents(dir);
    assert.equal(all.length, 3);
    assert.ok(all.some((event) => event.kind === 'transaction.commit'));
    assert.equal(inspectEventStore(dir).committedTransactions, 1);
    assert.equal(inspectEventStore(dir).ok, true);
    assert.equal(receipt.events.length, 2);
  } finally {
    cleanup();
  }
});

test('committed transaction visibility is permutation-invariant and fail-closed', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    const members = Array.from({ length: 6 }, (_, index) =>
      evt('ticket.delete', { ticketId: `T-${index}` }, `2026-01-01T00:00:0${index}.000Z`));
    appendTransaction(dir, members);
    const raw = readdirSync(dir).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')));
    const expected = committedEvents(raw).map((event) => event.id).sort();

    for (let seed = 1; seed <= 50; seed++) {
      let state = seed;
      const shuffled = [...raw];
      for (let i = shuffled.length - 1; i > 0; i--) {
        state = (state * 1664525 + 1013904223) >>> 0;
        const j = state % (i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      assert.deepEqual(committedEvents(shuffled).map((event) => event.id).sort(), expected);
    }
    assert.deepEqual(committedEvents(raw.filter((event) => event.kind !== 'transaction.commit')), []);
    assert.deepEqual(committedEvents(raw.filter((event) => event.transactionIndex !== 2)), []);
  } finally {
    cleanup();
  }
});
