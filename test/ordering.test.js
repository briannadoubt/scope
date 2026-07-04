import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { createTempScope } from './helpers.js';
import { openDb } from '../src/db.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { syncFromLog } from '../src/replay.js';
import { ensureEventLog } from '../src/backfill.js';
import {
  createTicket,
  updateTicket,
  listTickets,
  getTicket,
  listWorkspaceHistory,
} from '../src/repo.js';

const ids = (rows) => rows.map((r) => r.id);

test('SCP-243: fresh tickets default to number order (rank NULL falls back)', () => {
  const { db, cleanup } = createTempScope();
  try {
    const a = createTicket(db, { type: 'story', title: 'A', actor: 'bri' });
    const b = createTicket(db, { type: 'story', title: 'B', actor: 'bri' });
    const c = createTicket(db, { type: 'story', title: 'C', actor: 'bri' });
    // No ranks set yet → ordered by number, i.e. creation order (append-to-bottom).
    assert.deepEqual(ids(listTickets(db)), [a.id, b.id, c.id]);
    for (const t of [a, b, c]) assert.equal(getTicket(db, t.id).rank, null);
  } finally {
    cleanup();
  }
});

test('SCP-243: a fractional rank reorders within the column', () => {
  const { db, cleanup } = createTempScope();
  try {
    const a = createTicket(db, { type: 'story', title: 'A', actor: 'bri' });
    const b = createTicket(db, { type: 'story', title: 'B', actor: 'bri' });
    const c = createTicket(db, { type: 'story', title: 'C', actor: 'bri' });
    // Drag C to the top: give it a rank below A's effective rank (number=1).
    updateTicket(db, c.id, { rank: 0.5 }, 'bri');
    assert.deepEqual(ids(listTickets(db)), [c.id, a.id, b.id]);
    // Drag C between A and B: midpoint of their numbers (1 and 2).
    updateTicket(db, c.id, { rank: 1.5 }, 'bri');
    assert.deepEqual(ids(listTickets(db)), [a.id, c.id, b.id]);
    assert.equal(getTicket(db, c.id).rank, 1.5);
  } finally {
    cleanup();
  }
});

test('SCP-243: rank changes emit ticket.set_field but no history/audit row', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const a = createTicket(db, { type: 'story', title: 'A', actor: 'bri' });
    updateTicket(db, a.id, { rank: 3.25 }, 'bri');

    const evs = readAllEvents(eventsDir(scopeDir));
    const rankEvents = evs.filter(
      (e) => e.kind === 'ticket.set_field' && e.payload.field === 'rank'
    );
    assert.equal(rankEvents.length, 1, 'one set_field rank event emitted for sync');
    assert.equal(rankEvents[0].payload.value, 3.25);

    // ...but reorders are cosmetic: nothing lands in the audit history.
    const hist = listWorkspaceHistory(db);
    assert.equal(
      hist.filter((h) => h.field === 'rank').length,
      0,
      'rank changes are kept out of the history feed'
    );
  } finally {
    cleanup();
  }
});

test('SCP-243: an unchanged rank is a no-op (no event)', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const a = createTicket(db, { type: 'story', title: 'A', actor: 'bri' });
    updateTicket(db, a.id, { rank: 2 }, 'bri');
    const before = readAllEvents(eventsDir(scopeDir)).length;
    updateTicket(db, a.id, { rank: 2 }, 'bri'); // same value
    const after = readAllEvents(eventsDir(scopeDir)).length;
    assert.equal(after, before, 'no event emitted when rank is unchanged');
  } finally {
    cleanup();
  }
});

test('SCP-243: rank survives a cache rebuild from the event log', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const a = createTicket(db, { type: 'story', title: 'A', actor: 'bri' });
    const b = createTicket(db, { type: 'story', title: 'B', actor: 'bri' });
    updateTicket(db, b.id, { rank: 0.5 }, 'bri'); // B to the top
    ensureEventLog(db, scopeDir);
    const dbPath = db.name;
    db.close();

    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    assert.equal(existsSync(dbPath), false);

    const reopened = openDb(scopeDir);
    syncFromLog(reopened, scopeDir);
    // Order (B before A) and the concrete rank both survive the replay.
    assert.deepEqual(ids(listTickets(reopened)), [b.id, a.id]);
    assert.equal(getTicket(reopened, b.id).rank, 0.5);
    // And the replay did not synthesize a rank history row either.
    assert.equal(
      listWorkspaceHistory(reopened).filter((h) => h.field === 'rank').length,
      0
    );
    reopened.close();
  } finally {
    cleanup();
  }
});
