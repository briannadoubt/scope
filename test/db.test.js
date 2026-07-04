import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createTempScope } from './helpers.js';
import { openDb, nextTicketId, recordHistory } from '../src/db.js';

test('openDb is idempotent — re-opening the same dir reuses the schema', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const v1 = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    assert.equal(v1.value, '5');
    db.close();
    const db2 = openDb(scopeDir);
    const v2 = db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    assert.equal(v2.value, '5');
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

test('v1 → v3 migration renumbers globally when multiple projects collide', () => {
  // Simulate the v1 schema: projects table with two projects, each owning a
  // ticket numbered 1. The v2/v3 schema enforces UNIQUE(number) workspace-wide,
  // so a naive INSERT would hit a constraint violation. The migration should
  // assign fresh global numbers ordered by (created_at, id) and preserve IDs.
  const scopeDir = mkdtempSync(join(tmpdir(), 'scope-mig-'));
  try {
    const dbPath = join(scopeDir, 'scope.db');
    // Hand-build a v1 database (no schema_version row → migrate() picks it up
    // via the projects-table-exists branch).
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        overview TEXT DEFAULT '',
        next_ticket_number INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'backlog',
        priority TEXT DEFAULT 'medium',
        parent_id TEXT,
        branch TEXT,
        pr_url TEXT,
        assignee TEXT,
        labels TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, number)
      );
      INSERT INTO projects VALUES
        ('foo', 'FOO', 'Foo proj', '', '', 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ('bar', 'BAR', 'Bar proj', '', '', 2, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');
      INSERT INTO tickets (id, project_id, number, type, title, status, created_at, updated_at) VALUES
        ('FOO-1', 'foo', 1, 'story', 'foo-one', 'todo', '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z'),
        ('FOO-2', 'foo', 2, 'story', 'foo-two', 'todo', '2026-01-01T11:00:00Z', '2026-01-01T11:00:00Z'),
        ('BAR-1', 'bar', 1, 'story', 'bar-one', 'todo', '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z');
    `);
    seed.close();

    // Now open via openDb() — triggers the v1 → v3 migration. Before the fix
    // this throws a UNIQUE constraint error on number=1.
    const db = openDb(scopeDir);

    // Schema is now v3.
    const version = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    assert.equal(version.value, '5');

    // All three tickets survived, IDs are preserved verbatim.
    const ids = db.prepare('SELECT id FROM tickets ORDER BY number').all().map(r => r.id);
    assert.deepEqual(ids, ['FOO-1', 'FOO-2', 'BAR-1']);

    // Numbers are renumbered 1..3 in (created_at, id) order — no collisions.
    const numbers = db.prepare('SELECT number FROM tickets ORDER BY number').all().map(r => r.number);
    assert.deepEqual(numbers, [1, 2, 3]);

    // next_ticket_number advanced past the highest assigned.
    const ws = db.prepare('SELECT key, next_ticket_number FROM workspace WHERE id=1').get();
    assert.equal(ws.next_ticket_number, 4);
    // The first project (by created_at) wins the workspace key.
    assert.equal(ws.key, 'FOO');

    db.close();
  } finally {
    rmSync(scopeDir, { recursive: true, force: true });
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
