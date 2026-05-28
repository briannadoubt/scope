import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
 * Derive a sensible default workspace key from the .scope dir path.
 * Uses the parent directory's basename, uppercased letters only, trimmed to 10 chars.
 * Falls back to 'WORK' if nothing usable can be derived.
 */
function deriveDefaultKey(scopeDir) {
  if (!scopeDir) return 'WORK';
  try {
    const parent = dirname(resolve(scopeDir));
    const base = basename(parent);
    const letters = base.toUpperCase().replace(/[^A-Z]/g, '');
    if (!letters) return 'WORK';
    return letters.slice(0, 10);
  } catch {
    return 'WORK';
  }
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
  // foreign_keys is enabled AFTER migration; migrations run with FK off so
  // we can rename/drop tables that have inbound references without tripping
  // the constraint checker.
  migrate(db, scopeDir);
  db.pragma('foreign_keys = ON');
  return db;
}

/* ---------- Schema fragments ---------- */

const CREATE_WORKSPACE = `
  CREATE TABLE IF NOT EXISTS workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    overview TEXT DEFAULT '',
    next_ticket_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const CREATE_TICKETS = `
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
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
    UNIQUE(number)
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(type);
`;

const CREATE_AUX_TABLES = `
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
`;

const CURRENT_SCHEMA_VERSION = '3';

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

function getSchemaVersion(db) {
  if (!tableExists(db, 'meta')) return null;
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  return row?.value ?? null;
}

/**
 * Rebuild the auxiliary tables (ticket_relations / ticket_comments /
 * ticket_history) so their foreign keys point at the canonical `tickets`
 * table. Necessary after a v1→v2 migration that used ALTER TABLE RENAME
 * (which left FKs dangling at the renamed-then-dropped table). Also a
 * defensive no-op for fresh databases.
 *
 * MUST be called with foreign_keys = OFF.
 */
function rebuildAuxTables(db) {
  // Snapshot existing rows (tables may or may not exist).
  const relations = tableExists(db, 'ticket_relations')
    ? db.prepare('SELECT * FROM ticket_relations').all()
    : [];
  const comments = tableExists(db, 'ticket_comments')
    ? db.prepare('SELECT * FROM ticket_comments').all()
    : [];
  const history = tableExists(db, 'ticket_history')
    ? db.prepare('SELECT * FROM ticket_history').all()
    : [];

  // Drop and recreate with correct FK targets.
  db.exec(`
    DROP TABLE IF EXISTS ticket_relations;
    DROP TABLE IF EXISTS ticket_comments;
    DROP TABLE IF EXISTS ticket_history;
  `);
  db.exec(CREATE_AUX_TABLES);

  // Restore.
  if (relations.length) {
    const insert = db.prepare(
      `INSERT INTO ticket_relations
         (id, from_ticket_id, to_ticket_id, type, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const r of relations) {
      insert.run(r.id, r.from_ticket_id, r.to_ticket_id, r.type, r.created_at);
    }
  }
  if (comments.length) {
    const insert = db.prepare(
      `INSERT INTO ticket_comments
         (id, ticket_id, author, body, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const c of comments) {
      insert.run(c.id, c.ticket_id, c.author, c.body, c.created_at);
    }
  }
  if (history.length) {
    const insert = db.prepare(
      `INSERT INTO ticket_history
         (id, ticket_id, field, old_value, new_value, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const h of history) {
      insert.run(
        h.id, h.ticket_id, h.field, h.old_value, h.new_value, h.changed_by, h.changed_at
      );
    }
  }
}

/**
 * Run migrations to bring the database to the current schema version.
 *
 * Foreign keys are explicitly disabled for the duration of migration so we
 * can rename and drop tables that have inbound FK references without
 * tripping the FK checker. The caller re-enables FKs after `migrate()`
 * returns.
 */
function migrate(db, scopeDir) {
  db.pragma('foreign_keys = OFF');

  // Always ensure meta table exists first — we use it to track schema version.
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const version = getSchemaVersion(db);
  const hasProjects = tableExists(db, 'projects');
  const hasWorkspace = tableExists(db, 'workspace');
  const hasTickets = tableExists(db, 'tickets');

  // ── Fresh database (no schema yet) ───────────────────────────────────────
  if (!hasProjects && !hasWorkspace && !hasTickets) {
    const tx = db.transaction(() => {
      db.exec(CREATE_WORKSPACE);
      db.exec(CREATE_TICKETS);
      db.exec(CREATE_AUX_TABLES);
      const now = nowIso();
      db.prepare(
        `INSERT INTO workspace
           (id, key, name, description, overview, next_ticket_number, created_at, updated_at)
         VALUES (1, ?, ?, '', '', 1, ?, ?)`
      ).run(deriveDefaultKey(scopeDir), 'Workspace', now, now);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(CURRENT_SCHEMA_VERSION);
    });
    tx();
    return;
  }

  // ── v1 → v3 (workspace + tickets reshape + aux FK rebuild) ──────────────
  // v1 marker: projects table exists and workspace doesn't.
  if (hasProjects && !hasWorkspace) {
    const tx = db.transaction(() => {
      // Pick first project deterministically; synthesize one if missing.
      let project = db
        .prepare(
          `SELECT id, key, name, description, overview, next_ticket_number, created_at
           FROM projects
           ORDER BY created_at ASC, id ASC
           LIMIT 1`
        )
        .get();
      const now = nowIso();
      if (!project) {
        project = {
          key: deriveDefaultKey(scopeDir),
          name: 'Workspace',
          description: '',
          overview: '',
          next_ticket_number: 1,
          created_at: now,
        };
      }

      db.exec(CREATE_WORKSPACE);
      db.prepare(
        `INSERT INTO workspace
           (id, key, name, description, overview, next_ticket_number, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        project.key,
        project.name,
        project.description ?? '',
        project.overview ?? '',
        project.next_ticket_number ?? 1,
        project.created_at ?? now,
        now
      );

      // Rebuild tickets without project_id. Use the SQLite-recommended
      // "create new, copy, drop, rename" pattern. With foreign_keys OFF
      // (already disabled at top of migrate()) inbound FKs from aux tables
      // are not enforced during this swap.
      if (hasTickets) {
        db.exec(`
          DROP INDEX IF EXISTS idx_tickets_project;
          DROP INDEX IF EXISTS idx_tickets_status;
          DROP INDEX IF EXISTS idx_tickets_parent;
          DROP INDEX IF EXISTS idx_tickets_type;
        `);
        db.exec(`
          CREATE TABLE tickets_new (
            id TEXT PRIMARY KEY,
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
            UNIQUE(number)
          );
          -- Renumber globally. In v1, "number" was unique per project, so
          -- two projects in the same workspace could both have number=1. The
          -- v2 schema enforces UNIQUE(number) workspace-wide, so we assign
          -- fresh sequential numbers ordered by (created_at, id) for
          -- determinism. Ticket IDs are preserved verbatim (they are TEXT and
          -- still embed the original project key, so external references like
          -- branch names and commit messages keep working).
          INSERT INTO tickets_new
            (id, number, type, title, description, status, priority,
             parent_id, branch, pr_url, assignee, labels, created_at, updated_at)
          SELECT
             id,
             ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS number,
             type, title, description, status, priority,
             parent_id, branch, pr_url, assignee, labels, created_at, updated_at
          FROM tickets;
          DROP TABLE tickets;
          ALTER TABLE tickets_new RENAME TO tickets;

          CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
          CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_id);
          CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(type);
        `);

        // Advance next_ticket_number past the highest renumbered ticket so
        // new tickets don't reuse a number we just assigned.
        db.prepare(
          `UPDATE workspace
             SET next_ticket_number = COALESCE(
               (SELECT MAX(number) FROM tickets), 0
             ) + 1
           WHERE id = 1`
        ).run();
      } else {
        db.exec(CREATE_TICKETS);
      }

      db.exec(`DROP TABLE projects;`);

      // Rebuild aux tables so their FKs point at the new `tickets` table.
      rebuildAuxTables(db);

      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(CURRENT_SCHEMA_VERSION);
    });
    tx();

    // Sanity check after migration.
    const issues = db.prepare('PRAGMA foreign_key_check').all();
    if (issues.length) {
      throw new Error(
        `Migration left FK violations: ${JSON.stringify(issues)}`
      );
    }
    return;
  }

  // ── v2 → v3 (FK repair for buggy intermediate migration) ────────────────
  // v2 had a known issue: aux table FKs pointed at `tickets_v1` (the renamed
  // intermediate) which was then dropped, leaving dangling FK references.
  // Symptom: inserts/deletes on ticket_relations / ticket_comments /
  // ticket_history fail with `no such table: main.tickets_v1`.
  if (hasWorkspace && version !== CURRENT_SCHEMA_VERSION) {
    const tx = db.transaction(() => {
      rebuildAuxTables(db);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(CURRENT_SCHEMA_VERSION);
    });
    tx();

    const issues = db.prepare('PRAGMA foreign_key_check').all();
    if (issues.length) {
      throw new Error(
        `v2→v3 FK repair left violations: ${JSON.stringify(issues)}`
      );
    }
    return;
  }

  // ── Already current ─────────────────────────────────────────────────────
  // Idempotent: ensure tables and indexes exist (defensive for legacy DBs).
  db.exec(CREATE_WORKSPACE);
  db.exec(CREATE_TICKETS);
  db.exec(CREATE_AUX_TABLES);
  const existing = db.prepare('SELECT id FROM workspace WHERE id = 1').get();
  if (!existing) {
    const now = nowIso();
    db.prepare(
      `INSERT INTO workspace
         (id, key, name, description, overview, next_ticket_number, created_at, updated_at)
       VALUES (1, ?, ?, '', '', 1, ?, ?)`
    ).run(deriveDefaultKey(scopeDir), 'Workspace', now, now);
  }
  if (!version) {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('schema_version', ?)"
    ).run(CURRENT_SCHEMA_VERSION);
  }
}

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Return the singleton workspace row. Throws if missing.
 */
export function getWorkspace(db) {
  const row = db.prepare('SELECT * FROM workspace WHERE id = 1').get();
  if (!row) throw new Error('Workspace row missing — database not initialized.');
  return row;
}

/**
 * Reserve the next ticket number for the workspace (atomic).
 * Returns { id, number } where id is like 'SCP-7'.
 */
export const nextTicketId = (db) => {
  const tx = db.transaction(() => {
    const ws = db
      .prepare('SELECT key, next_ticket_number FROM workspace WHERE id = 1')
      .get();
    if (!ws) throw new Error('Workspace row missing — database not initialized.');
    const number = ws.next_ticket_number;
    db.prepare(
      'UPDATE workspace SET next_ticket_number = next_ticket_number + 1, updated_at = ? WHERE id = 1'
    ).run(nowIso());
    return { id: `${ws.key}-${number}`, number };
  });
  return tx();
};

export function recordHistory(db, ticketId, field, oldValue, newValue, who = null) {
  if (String(oldValue ?? '') === String(newValue ?? '')) return null;
  const result = db.prepare(
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
  return Number(result.lastInsertRowid);
}
