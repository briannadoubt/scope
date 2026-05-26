import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { openDb, nextTicketId, recordHistory } from '../src/db.js';

test('openDb is idempotent — re-opening the same dir reuses the schema', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const v1 = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    assert.equal(v1.value, '1');
    db.close();
    const db2 = openDb(scopeDir);
    const v2 = db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    assert.equal(v2.value, '1');
    db2.close();
  } finally {
    cleanup();
  }
});

test('nextTicketId increments atomically and uses the project key as prefix', () => {
  const { db, cleanup } = createTempScope();
  try {
    db.prepare(
      `INSERT INTO projects (id, key, name, created_at, updated_at)
       VALUES ('app', 'APP', 'App', datetime('now'), datetime('now'))`
    ).run();
    const a = nextTicketId(db, 'app');
    const b = nextTicketId(db, 'app');
    const c = nextTicketId(db, 'app');
    assert.deepEqual([a.id, b.id, c.id], ['APP-1', 'APP-2', 'APP-3']);
    assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);
    const row = db.prepare('SELECT next_ticket_number FROM projects WHERE id=?').get('app');
    assert.equal(row.next_ticket_number, 4);
  } finally {
    cleanup();
  }
});

test('nextTicketId throws when the project is unknown', () => {
  const { db, cleanup } = createTempScope();
  try {
    assert.throws(() => nextTicketId(db, 'nope'), /Project not found/);
  } finally {
    cleanup();
  }
});

test('recordHistory skips no-op transitions and persists real ones', () => {
  const { db, cleanup } = createTempScope();
  try {
    db.prepare(
      `INSERT INTO projects (id, key, name, created_at, updated_at)
       VALUES ('app', 'APP', 'App', datetime('now'), datetime('now'))`
    ).run();
    db.prepare(
      `INSERT INTO tickets (id, project_id, number, type, title, status, created_at, updated_at)
       VALUES ('APP-1', 'app', 1, 'story', 'x', 'todo', datetime('now'), datetime('now'))`
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
