import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const SCOPE_DIR_NAME = '.scope';
export const DB_FILE_NAME = 'scope.db';

/**
 * Walk up from `start` looking for a `.scope/` directory.
 * Returns the absolute path to the .scope directory, or null.
 */
export function findScopeDir(start = process.cwd()) {
  let dir = resolve(start);
  const root = resolve('/');
  while (true) {
    const candidate = join(dir, SCOPE_DIR_NAME);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function defaultScopeDir(cwd = process.cwd()) {
  return join(resolve(cwd), SCOPE_DIR_NAME);
}

/**
 * Open (or create) the SQLite database in the given .scope dir.
 * Runs migrations on open.
 */
export function openDb(scopeDir) {
  if (!scopeDir) {
    throw new Error(
      "No .scope/ directory found. Run `scope init` in your project root first."
    );
  }
  if (!existsSync(scopeDir)) mkdirSync(scopeDir, { recursive: true });
  const dbPath = join(scopeDir, DB_FILE_NAME);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      overview TEXT DEFAULT '',
      next_ticket_number INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('epic','story','bug')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK(status IN ('backlog','todo','in_progress','in_review','done','cancelled')),
      priority TEXT DEFAULT 'medium'
        CHECK(priority IN ('low','medium','high','urgent')),
      parent_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
      branch TEXT,
      pr_url TEXT,
      assignee TEXT,
      labels TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, number)
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(type);

    CREATE TABLE IF NOT EXISTS ticket_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      to_ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      type TEXT NOT NULL
        CHECK(type IN ('blocks','blocked_by','relates_to','duplicates','duplicate_of')),
      created_at TEXT NOT NULL,
      UNIQUE(from_ticket_id, to_ticket_id, type)
    );

    CREATE INDEX IF NOT EXISTS idx_relations_from ON ticket_relations(from_ticket_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON ticket_relations(to_ticket_id);

    CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      author TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_comments_ticket ON ticket_comments(ticket_id);

    CREATE TABLE IF NOT EXISTS ticket_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_by TEXT,
      changed_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_history_ticket ON ticket_history(ticket_id);
  `);

  const schemaVersion = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  if (!schemaVersion) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  }
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Reserve the next ticket number for a project (atomic).
 * Returns the new ticket id like 'SCP-7'.
 */
export function nextTicketId(db, projectId) {
  const project = db
    .prepare('SELECT key, next_ticket_number FROM projects WHERE id = ?')
    .get(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const number = project.next_ticket_number;
  db.prepare(
    'UPDATE projects SET next_ticket_number = next_ticket_number + 1, updated_at = ? WHERE id = ?'
  ).run(nowIso(), projectId);
  return { id: `${project.key}-${number}`, number };
}

export function recordHistory(db, ticketId, field, oldValue, newValue, who = null) {
  if (String(oldValue ?? '') === String(newValue ?? '')) return;
  db.prepare(
    `INSERT INTO ticket_history (ticket_id, field, old_value, new_value, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    ticketId,
    field,
    oldValue == null ? null : String(oldValue),
    newValue == null ? null : String(newValue),
    who,
    nowIso()
  );
}
