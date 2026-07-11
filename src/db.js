import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { ulid } from './ulid.js';
import { formatActor } from './event-schema.js';
import { storageMode, updateScopeGitignore, workspaceDbPath } from './workspace-storage.js';
import { DEFAULT_COLUMNS, parseColumns } from './columns.js';

export const SCOPE_DIR_NAME = '.scope';
export const DB_FILE_NAME = 'scope.db';

/**
 * Ensure `.scope/.gitignore` exists for the workspace's storage mode.
 * Idempotent; only writes when missing.
 */
export function ensureScopeGitignore(scopeDir) {
  const path = join(scopeDir, '.gitignore');
  if (!existsSync(path)) {
    try {
      mkdirSync(scopeDir, { recursive: true });
      updateScopeGitignore(scopeDir, storageMode(scopeDir));
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Walk up from `start` looking for a `.scope/` directory.
 * Returns the absolute path to the .scope directory, or null.
 */
export function findScopeDir(start = process.cwd()) {
  // An explicit SCOPE_DIR (hosted deploys point this at the persistent volume,
  // e.g. /data/.scope) is authoritative and short-circuits the upward walk
  // (SCP-163). Only honored when it already exists, so `init` can still create it.
  const env = process.env.SCOPE_DIR;
  if (env && existsSync(env)) return resolve(env);

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
  // Honor SCOPE_DIR so `scope init` targets the configured location (the volume
  // in a hosted deploy) rather than the container's working directory.
  if (process.env.SCOPE_DIR) return resolve(process.env.SCOPE_DIR);
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
    // The key must satisfy the event keyPrefix regex ^[A-Z][A-Z0-9]{1,9}$
    // (2-10 chars). A 1-letter parent dir (e.g. macOS temp under .../T) would
    // otherwise produce an invalid single-char key, so fall back when too short.
    if (letters.length < 2) return 'WORK';
    return letters.slice(0, 10);
  } catch {
    return 'WORK';
  }
}

/**
 * Open (or create) the SQLite database in the given .scope dir.
 * Runs migrations on open.
 * @param {string} scopeDir  Path to the `.scope/` directory.
 * @returns {import('./types.js').Database}
 */
export function openDb(scopeDir) {
  if (!scopeDir) {
    throw new Error(
      "No .scope/ directory found. Run `scope init` in your project root first."
    );
  }
  if (!existsSync(scopeDir)) mkdirSync(scopeDir, { recursive: true });
  const dbPath = workspaceDbPath(scopeDir);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // foreign_keys is enabled AFTER migration; migrations run with FK off so
  // we can rename/drop tables that have inbound references without tripping
  // the constraint checker.
  migrate(db, scopeDir);
  db.pragma('foreign_keys = ON');
  // Full-text search index lives outside the versioned schema: it's a pure
  // derivative of tickets + comments, kept in sync by triggers and rebuilt
  // from scratch whenever it's missing/empty. Orthogonal to migrations, so we
  // (re)establish it on every open regardless of which migration branch ran.
  ensureSearchIndex(db);
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
    columns TEXT DEFAULT '[]',
    next_ticket_number INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const CREATE_TICKETS = `
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    uid TEXT,
    number INTEGER NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('epic','story','bug')),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT DEFAULT 'medium'
      CHECK(priority IN ('low','medium','high','urgent')),
    parent_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
    branch TEXT,
    pr_url TEXT,
    assignee TEXT,
    labels TEXT DEFAULT '[]',
    rank REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(number)
  );
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(type);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_uid ON tickets(uid);
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

/* ---------- Full-text search (FTS5) ---------- */

// A single contentful FTS5 table with one row per ticket. Comment bodies are
// folded into the `comments` column (concatenated) so a ticket matches on its
// discussion too. `ticket_id` holds the human key (e.g. "SCP-7") and is the
// join key back to `tickets` — it's left searchable so "SCP-7" finds SCP-7.
//
// It's a plain (non-external-content) FTS5 table, so ordinary INSERT/UPDATE/
// DELETE in the sync triggers Just Work.
const CREATE_SEARCH_TABLE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS tickets_fts USING fts5(
    ticket_id,
    number,
    title,
    description,
    assignee,
    labels,
    branch,
    pr_url,
    comments,
    tokenize = 'unicode61 remove_diacritics 2'
  );
`;

// Triggers keep the index in lockstep with every write path (CLI, server,
// direct SQL), so we never have to remember to reindex by hand. They are
// DROPped and recreated on every `openDb` (see ensureSearchIndex) so a change
// to a trigger body here actually reaches databases created by an older build
// — the `IF NOT EXISTS` form alone would silently keep a stale definition.
const DROP_SEARCH_TRIGGERS = `
  DROP TRIGGER IF EXISTS tickets_fts_ai;
  DROP TRIGGER IF EXISTS tickets_fts_au;
  DROP TRIGGER IF EXISTS tickets_fts_ad;
  DROP TRIGGER IF EXISTS comments_fts_ai;
  DROP TRIGGER IF EXISTS comments_fts_au;
  DROP TRIGGER IF EXISTS comments_fts_ad;
`;

const CREATE_SEARCH_TRIGGERS = `
  CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
    INSERT INTO tickets_fts
      (ticket_id, number, title, description, assignee, labels, branch, pr_url, comments)
    VALUES
      (NEW.id, NEW.number, NEW.title, COALESCE(NEW.description,''),
       COALESCE(NEW.assignee,''), COALESCE(NEW.labels,''),
       COALESCE(NEW.branch,''), COALESCE(NEW.pr_url,''), '');
  END;

  -- Only fires when an indexed text column actually changes, so routine
  -- status/priority/parent/updated_at edits (the bulk of board churn) don't
  -- pay to re-tokenize the whole searchable row. \`IS NOT\` is NULL-safe.
  CREATE TRIGGER tickets_fts_au AFTER UPDATE ON tickets
  WHEN NEW.number      IS NOT OLD.number
    OR NEW.title       IS NOT OLD.title
    OR NEW.description IS NOT OLD.description
    OR NEW.assignee    IS NOT OLD.assignee
    OR NEW.labels      IS NOT OLD.labels
    OR NEW.branch      IS NOT OLD.branch
    OR NEW.pr_url      IS NOT OLD.pr_url
  BEGIN
    UPDATE tickets_fts SET
      number      = NEW.number,
      title       = NEW.title,
      description = COALESCE(NEW.description,''),
      assignee    = COALESCE(NEW.assignee,''),
      labels      = COALESCE(NEW.labels,''),
      branch      = COALESCE(NEW.branch,''),
      pr_url      = COALESCE(NEW.pr_url,'')
    WHERE ticket_id = NEW.id;
  END;

  CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
    DELETE FROM tickets_fts WHERE ticket_id = OLD.id;
  END;

  CREATE TRIGGER comments_fts_ai AFTER INSERT ON ticket_comments BEGIN
    UPDATE tickets_fts SET comments = COALESCE(
      (SELECT group_concat(COALESCE(author,'') || ' ' || body, ' ')
         FROM ticket_comments WHERE ticket_id = NEW.ticket_id), '')
    WHERE ticket_id = NEW.ticket_id;
  END;

  CREATE TRIGGER comments_fts_au AFTER UPDATE ON ticket_comments BEGIN
    UPDATE tickets_fts SET comments = COALESCE(
      (SELECT group_concat(COALESCE(author,'') || ' ' || body, ' ')
         FROM ticket_comments WHERE ticket_id = NEW.ticket_id), '')
    WHERE ticket_id = NEW.ticket_id;
  END;

  CREATE TRIGGER comments_fts_ad AFTER DELETE ON ticket_comments BEGIN
    UPDATE tickets_fts SET comments = COALESCE(
      (SELECT group_concat(COALESCE(author,'') || ' ' || body, ' ')
         FROM ticket_comments WHERE ticket_id = OLD.ticket_id), '')
    WHERE ticket_id = OLD.ticket_id;
  END;
`;

const POPULATE_SEARCH = `
  INSERT INTO tickets_fts
    (ticket_id, number, title, description, assignee, labels, branch, pr_url, comments)
  SELECT
    t.id, t.number, t.title, COALESCE(t.description,''),
    COALESCE(t.assignee,''), COALESCE(t.labels,''),
    COALESCE(t.branch,''), COALESCE(t.pr_url,''),
    COALESCE((SELECT group_concat(COALESCE(c.author,'') || ' ' || c.body, ' ')
                FROM ticket_comments c WHERE c.ticket_id = t.id), '')
  FROM tickets t;
`;

/**
 * Ensure the FTS5 search index + sync triggers exist and are current, and
 * (re)build the index whenever it's out of step with `tickets`.
 *
 * Triggers are dropped+recreated every call so a definition change here lands
 * on older databases. The index is rebuilt whenever its row count doesn't
 * match the ticket count — covering first-open-after-upgrade (empty index),
 * AND a partially-populated/stale index (e.g. rows added while triggers were
 * transiently absent), which the old empty-only check would never repair.
 * Steady state is two COUNTs and six cheap DDL statements — fine per openDb.
 */
export function ensureSearchIndex(db) {
  db.exec(CREATE_SEARCH_TABLE);
  db.exec(DROP_SEARCH_TRIGGERS);
  db.exec(CREATE_SEARCH_TRIGGERS);
  const ftsCount = db.prepare('SELECT count(*) AS n FROM tickets_fts').get().n;
  const ticketCount = db.prepare('SELECT count(*) AS n FROM tickets').get().n;
  if (ftsCount !== ticketCount) {
    db.exec('DELETE FROM tickets_fts');
    if (ticketCount > 0) db.exec(POPULATE_SEARCH);
  }
}

const CURRENT_SCHEMA_VERSION = '6';

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}

function defaultColumnsJson() {
  return JSON.stringify(DEFAULT_COLUMNS);
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
 * v3 → v4: give every ticket a stable ULID identity (`uid`) for the
 * event-sourced store (SCP-108/110). Idempotent — a no-op once the column and
 * index exist. Existing rows are backfilled with fresh ULIDs in created_at
 * order; new tickets get their uid from createTicket().
 *
 * MUST be called with foreign_keys = OFF (it runs during migrate()).
 */
function ensureUidColumn(db) {
  const cols = db.prepare('PRAGMA table_info(tickets)').all();
  if (!cols.some((c) => c.name === 'uid')) {
    db.exec('ALTER TABLE tickets ADD COLUMN uid TEXT');
    const rows = db.prepare('SELECT id FROM tickets ORDER BY created_at ASC, id ASC').all();
    const upd = db.prepare('UPDATE tickets SET uid = ? WHERE id = ?');
    for (const r of rows) upd.run(ulid(), r.id);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_uid ON tickets(uid)');
}

function ensureWorkspaceColumnsColumn(db) {
  const cols = db.prepare('PRAGMA table_info(workspace)').all();
  if (!cols.some((c) => c.name === 'columns')) {
    db.exec("ALTER TABLE workspace ADD COLUMN columns TEXT DEFAULT '[]'");
  }
  db.prepare("UPDATE workspace SET columns = ? WHERE columns IS NULL OR columns = '' OR columns = '[]'")
    .run(defaultColumnsJson());
}

function ticketsSql(db) {
  return db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tickets'")
    .get()?.sql || '';
}

function ensureDynamicStatusColumn(db) {
  if (!/CHECK\s*\(\s*status\s+IN/i.test(ticketsSql(db))) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_tickets_status;
    DROP INDEX IF EXISTS idx_tickets_parent;
    DROP INDEX IF EXISTS idx_tickets_type;
    DROP INDEX IF EXISTS idx_tickets_uid;

    CREATE TABLE tickets_dynamic (
      id TEXT PRIMARY KEY,
      uid TEXT,
      number INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('epic','story','bug')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT DEFAULT 'medium'
        CHECK(priority IN ('low','medium','high','urgent')),
      parent_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
      branch TEXT,
      pr_url TEXT,
      assignee TEXT,
      labels TEXT DEFAULT '[]',
      rank REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(number)
    );
    INSERT INTO tickets_dynamic
      (id, uid, number, type, title, description, status, priority,
       parent_id, branch, pr_url, assignee, labels, rank, created_at, updated_at)
    SELECT id, uid, number, type, title, description, status, priority,
           parent_id, branch, pr_url, assignee, labels, rank, created_at, updated_at
    FROM tickets;
    DROP TABLE tickets;
    ALTER TABLE tickets_dynamic RENAME TO tickets;

    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(type);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_uid ON tickets(uid);
  `);
}

/**
 * v4 → v5: give every ticket a numeric `rank` for user-defined ordering within
 * a board column (SCP-243). Idempotent — a no-op once the column exists.
 * Existing rows are backfilled with `rank = number` so the default order is
 * identical to the legacy `ORDER BY number`; thereafter reorders write a
 * fractional rank via `ticket.set_field`. The board sorts on
 * `COALESCE(rank, number)`, so un-ranked rows (e.g. fresh replays that never
 * carried a rank event) still fall back to number order.
 *
 * MUST be called with foreign_keys = OFF (it runs during migrate()).
 */
function ensureRankColumn(db) {
  const cols = db.prepare('PRAGMA table_info(tickets)').all();
  if (!cols.some((c) => c.name === 'rank')) {
    db.exec('ALTER TABLE tickets ADD COLUMN rank REAL');
    db.exec('UPDATE tickets SET rank = number WHERE rank IS NULL');
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
           (id, key, name, description, overview, columns, next_ticket_number, created_at, updated_at)
         VALUES (1, ?, ?, '', '', ?, 1, ?, ?)`
      ).run(deriveDefaultKey(scopeDir), 'Workspace', defaultColumnsJson(), now, now);
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
           (id, key, name, description, overview, columns, next_ticket_number, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        project.key,
        project.name,
        project.description ?? '',
        project.overview ?? '',
        defaultColumnsJson(),
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
            status TEXT NOT NULL DEFAULT 'backlog',
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

      // v4: stable ULID identity for every ticket.
      ensureUidColumn(db);
      // v5: numeric rank for user-defined column ordering (SCP-243).
      ensureRankColumn(db);
      ensureWorkspaceColumnsColumn(db);
      ensureDynamicStatusColumn(db);

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

  // ── Upgrade an existing workspace DB to the current version ──────────────
  // Two independent steps, each idempotent and applied as needed:
  //   • v2→v3: aux-table FK repair. v2 had a known issue where aux table FKs
  //     pointed at `tickets_v1` (the renamed intermediate) which was then
  //     dropped, leaving dangling FK references. Only needed for pre-v3 DBs.
  //   • v3→v4: stable ULID `uid` on every ticket (SCP-108/110).
  if (hasWorkspace && version !== CURRENT_SCHEMA_VERSION) {
    const v = Number(version) || 0;
    const tx = db.transaction(() => {
      if (v < 3) rebuildAuxTables(db);
      ensureUidColumn(db);
      ensureRankColumn(db);
      ensureWorkspaceColumnsColumn(db);
      ensureDynamicStatusColumn(db);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(CURRENT_SCHEMA_VERSION);
    });
    tx();

    const issues = db.prepare('PRAGMA foreign_key_check').all();
    if (issues.length) {
      throw new Error(
        `migration to v${CURRENT_SCHEMA_VERSION} left FK violations: ${JSON.stringify(issues)}`
      );
    }
    return;
  }

  // ── Already current ─────────────────────────────────────────────────────
  // Idempotent: ensure tables and indexes exist (defensive for legacy DBs).
  db.exec(CREATE_WORKSPACE);
  db.exec(CREATE_TICKETS);
  db.exec(CREATE_AUX_TABLES);
  ensureUidColumn(db);
  ensureRankColumn(db);
  ensureWorkspaceColumnsColumn(db);
  ensureDynamicStatusColumn(db);
  const existing = db.prepare('SELECT id FROM workspace WHERE id = 1').get();
  if (!existing) {
    const now = nowIso();
    db.prepare(
      `INSERT INTO workspace
         (id, key, name, description, overview, columns, next_ticket_number, created_at, updated_at)
       VALUES (1, ?, ?, '', '', ?, 1, ?, ?)`
    ).run(deriveDefaultKey(scopeDir), 'Workspace', defaultColumnsJson(), now, now);
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
 * @param {import('./types.js').Database} db
 * @returns {import('./types.js').Workspace}
 */
export function getWorkspace(db) {
  const row = db.prepare('SELECT * FROM workspace WHERE id = 1').get();
  if (!row) throw new Error('Workspace row missing — database not initialized.');
  return {
    ...row,
    columns: parseColumns(row.columns),
  };
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

/* ---------- meta key/value helpers ---------- */

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

/** Atomically increment an integer meta counter, returning the new value. */
export function bumpMeta(db, key, by = 1) {
  const next = (Number(getMeta(db, key)) || 0) + by;
  setMeta(db, key, next);
  return next;
}

export function recordHistory(db, ticketId, field, oldValue, newValue, who = null, model = null) {
  if (String(oldValue ?? '') === String(newValue ?? '')) return null;
  // Store the rendered attribution ("{model} on behalf of {who}") in the
  // disposable cache so every history/UI surface shows it without a schema
  // change. The event log keeps actor + model separate as the source of truth.
  const result = db.prepare(
    `INSERT INTO ticket_history (ticket_id, field, old_value, new_value, changed_by, changed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    ticketId,
    field,
    oldValue == null ? null : String(oldValue),
    newValue == null ? null : String(newValue),
    who == null ? null : formatActor(who, model),
    nowIso()
  );
  return Number(result.lastInsertRowid);
}
