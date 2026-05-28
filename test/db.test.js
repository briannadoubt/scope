import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { openDb, nextTicketId, recordHistory } from '../src/db.js';

test('openDb is idempotent — re-opening the same dir reuses the schema', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const v1 = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    assert.equal(v1.value, '3');
    db.close();
    const db2 = openDb(scopeDir);
    const v2 = db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    assert.equal(v2.value, '3');
    db2.close();
  } finally {
    cleanup();
  }
});

test('nextTicketId increments atomically and uses the workspace key as prefix', () => {
  const { db, cleanup } = createTempScope();
  try {
    // The fresh DB already has a singleton workspace row. Set a known key so
    // the assertions don't depend on the tmpdir name.
    db.prepare(
      "UPDATE workspace SET key = 'APP', updated_at = datetime('now') WHERE id = 1"
    ).run();
    const a = nextTicketId(db);
    const b = nextTicketId(db);
    const c = nextTicketId(db);
    assert.deepEqual([a.id, b.id, c.id], ['APP-1', 'APP-2', 'APP-3']);
    assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);
    const row = db.prepare('SELECT next_ticket_number FROM workspace WHERE id = 1').get();
    assert.equal(row.next_ticket_number, 4);
  } finally {
    cleanup();
  }
});

test('nextTicketId throws when workspace row is missing', () => {
  const { db, cleanup } = createTempScope();
  try {
    db.prepare('DELETE FROM workspace WHERE id = 1').run();
    assert.throws(() => nextTicketId(db), /Workspace row missing/);
  } finally {
    cleanup();
  }
});

test('recordHistory skips no-op transitions and persists real ones', () => {
  const { db, cleanup } = createTempScope();
  try {
    // Insert a ticket directly against the singleton workspace (no project_id
    // column in v3).
    db.prepare(
      `INSERT INTO tickets (id, number, type, title, status, created_at, updated_at)
       VALUES ('APP-1', 1, 'story', 'x', 'todo', datetime('now'), datetime('now'))`
    ).run();
    recordHistory(db, 'APP-1', 'status', 'todo', 'todo', 'me'); // no-op
    recordHistory(db, 'APP-1', 'status', 'todo', 'done', 'me');
    const rows = db.prepare('SELECT field, old_value, new_value, changed_by FROM ticket_history WHERE ticket_id=?').all('APP-1');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { field: 'status', old_value: 'todo', new_value: 'done', changed_by: 'me' });
  } finally {
    cleanup();
  }
});
