import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendEvent, readAllEvents, eventsDir } from '../src/event-store.js';
import { makeEvent } from '../src/event-schema.js';

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

test('readAllEvents on a missing dir returns []', () => {
  const { dir, cleanup } = tmpEventsDir();
  try {
    assert.deepEqual(readAllEvents(dir), []);
  } finally {
    cleanup();
  }
});
