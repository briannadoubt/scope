import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope, startTestServer, apiFetch } from './helpers.js';
import { ensureEventLog } from '../src/backfill.js';
import { replayInto } from '../src/replay.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import {
  createTicket,
  getWorkspace,
  updateTicket,
  updateWorkspace,
} from '../src/repo.js';

const customColumns = [
  { id: 'triage', label: 'Triage', color: '#ca8a04', kind: 'open', order: 10 },
  { id: 'building', label: 'Building', color: '#2563eb', kind: 'open', order: 20 },
  { id: 'shipped', label: 'Shipped', color: '#16a34a', kind: 'done', order: 30 },
  { id: 'parked', label: 'Parked', color: '#64748b', kind: 'cancelled', order: 40 },
];

test('workspace columns persist and drive ticket status validation', () => {
  const { db, cleanup } = createTempScope();
  try {
    updateWorkspace(db, { columns: customColumns });
    assert.deepEqual(getWorkspace(db).columns, customColumns);

    const ticket = createTicket(db, { type: 'story', title: 'Dynamic', status: 'triage' });
    assert.equal(ticket.status, 'triage');
    const moved = updateTicket(db, ticket.id, { status: 'building' });
    assert.equal(moved.status, 'building');
    assert.throws(
      () => updateTicket(db, ticket.id, { status: 'not_a_column' }),
      /Invalid status/
    );
  } finally {
    cleanup();
  }
});

test('custom column config survives event-log replay', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    updateWorkspace(db, { columns: customColumns });
    createTicket(db, { type: 'story', title: 'Replay me', status: 'triage' });
    ensureEventLog(db, scopeDir);
    db.prepare('UPDATE workspace SET columns = ? WHERE id = 1').run('[]');
    db.prepare('DELETE FROM tickets').run();

    replayInto(db, readAllEvents(eventsDir(scopeDir)));
    assert.deepEqual(getWorkspace(db).columns, customColumns);
  } finally {
    cleanup();
  }
});

test('server meta and board expose workspace columns and buckets', async () => {
  const t = await startTestServer();
  try {
    updateWorkspace(t.scope.db, { columns: customColumns });
    createTicket(t.scope.db, { type: 'story', title: 'Visible', status: 'triage' });

    const meta = await apiFetch(t.baseUrl, '/api/meta');
    assert.equal(meta.status, 200);
    assert.deepEqual(meta.data.columns, customColumns);

    const board = await apiFetch(t.baseUrl, '/api/board');
    assert.equal(board.status, 200);
    assert.deepEqual(board.data.columns.map((c) => c.id), ['triage', 'building', 'shipped']);
    assert.equal(board.data.buckets.triage[0].title, 'Visible');
    assert.deepEqual(board.data.terminal_columns.map((c) => c.id), ['parked']);
  } finally {
    await t.close();
  }
});
