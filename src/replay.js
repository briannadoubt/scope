/**
 * Replay — project the append-only event log into the materialized SQLite
 * tables (SCP-109). This is the inverse of the emit path (SCP-108): events are
 * the source of truth, `scope.db` is a derived cache that `replayInto` rebuilds
 * deterministically.
 *
 * Determinism comes from applying events in canonical order (compareEvents) and
 * assigning display numbers with the SCP-110 resolver. Replay writes directly
 * to the tables (raw SQL) so it never re-emits events — no feedback loop.
 */

import { existsSync, readdirSync } from 'node:fs';

import { nowIso, openDb, defaultScopeDir, findScopeDir, getMeta, setMeta } from './db.js';
import { compareEvents } from './event-schema.js';
import { resolveDisplayNumbers, nextNumberSeed } from './identity.js';
import { readAllEvents, eventsDir } from './event-store.js';
import { COLUMN_TO_FIELD, RELATION_INVERSE } from './enums.js';

/** Count event files in a .scope dir (cheap staleness signal; log is append-only). */
export function countEventFiles(scopeDir) {
  const dir = eventsDir(scopeDir);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).length;
}

/**
 * Rebuild the db from the log iff it is out of step (SCP-111). The db is a
 * cache: the on-disk event count is the source of truth for "how much should be
 * applied". Because the log is append-only, a mismatch between the file count
 * and the db's `applied_event_count` means new events arrived (e.g. a git pull
 * or another process) — so replay. The common case (live writer kept the count
 * in step) is a no-op.
 *
 * @returns {{ rebuilt: boolean, count: number }}
 */
export function syncFromLog(db, scopeDir) {
  const diskCount = countEventFiles(scopeDir);
  const applied = Number(getMeta(db, 'applied_event_count')) || 0;
  if (diskCount === applied) return { rebuilt: false, count: diskCount };
  replayInto(db, readAllEvents(eventsDir(scopeDir)));
  setMeta(db, 'applied_event_count', diskCount);
  return { rebuilt: true, count: diskCount };
}

// event field name -> DB column (inverse of COLUMN_TO_FIELD)
const FIELD_TO_COLUMN = Object.fromEntries(
  Object.entries(COLUMN_TO_FIELD).map(([col, field]) => [field, col])
);

/**
 * Rebuild the materialized tables of `db` from `events`. Wipes the ticket data
 * first, then applies every event in canonical order. The workspace singleton's
 * mutable fields are rebuilt from workspace.* events (last-writer-wins).
 *
 * @param {Database} db - an open better-sqlite3 handle (schema already migrated)
 * @param {Array<object>} events - events (any order; sorted internally)
 * @returns {{ applied: number, renumbered: Array }}
 */
export function replayInto(db, events) {
  const ordered = events.slice().sort(compareEvents);
  const { assignments, renumbered } = resolveDisplayNumbers(ordered);

  // uid -> human KEY-N id (the value the tickets table keys on). Translates the
  // ULID references in events back into the DB's human ids.
  const human = new Map();
  for (const [uid, a] of assignments) human.set(uid, a.humanId);

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    // Clear derived state. The workspace row (singleton) is updated in place.
    db.exec(`
      DELETE FROM ticket_history;
      DELETE FROM ticket_comments;
      DELETE FROM ticket_relations;
      DELETE FROM tickets;
    `);

    let wsKey = null;
    let applied = 0;
    for (const e of ordered) {
      applied += applyEvent(db, e, human, assignments);
      if (e.kind === 'workspace.init' || e.kind === 'workspace.set') {
        if (typeof e.payload.key === 'string') wsKey = e.payload.key;
      }
    }

    // Orphan cleanup mirrors the FK CASCADE the live path relies on: a delete
    // event removes the ticket, so its comments/relations must go too even if
    // their events were applied earlier.
    db.exec(`
      DELETE FROM ticket_comments WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM ticket_relations
        WHERE from_ticket_id NOT IN (SELECT id FROM tickets)
           OR to_ticket_id   NOT IN (SELECT id FROM tickets);
      DELETE FROM ticket_history WHERE ticket_id NOT IN (SELECT id FROM tickets);
    `);

    // Advance the local allocator past every assigned number.
    db.prepare('UPDATE workspace SET next_ticket_number = ?, updated_at = ? WHERE id = 1').run(
      nextNumberSeed(assignments),
      nowIso()
    );
    if (wsKey) {
      db.prepare('UPDATE workspace SET key = ? WHERE id = 1').run(wsKey);
    }

    return applied;
  });
  const applied = tx();
  db.pragma('foreign_keys = ON');

  const issues = db.prepare('PRAGMA foreign_key_check').all();
  if (issues.length) {
    throw new Error(`replay left FK violations: ${JSON.stringify(issues)}`);
  }
  return { applied, renumbered };
}

function applyEvent(db, e, human, assignments) {
  const p = e.payload;
  switch (e.kind) {
    case 'workspace.init':
    case 'workspace.set': {
      const cols = ['key', 'name', 'description', 'overview'].filter((k) => k in p);
      if (cols.length) {
        const sets = cols.map((c) => `${c} = ?`).join(', ');
        db.prepare(`UPDATE workspace SET ${sets} WHERE id = 1`).run(...cols.map((c) => p[c]));
      }
      return 1;
    }

    case 'ticket.create': {
      const id = human.get(p.ticketId);
      const a = assignments.get(p.ticketId);
      db.prepare(
        `INSERT INTO tickets
           (id, uid, number, type, title, description, status, priority,
            parent_id, branch, pr_url, assignee, labels, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        p.ticketId,
        a.number,
        p.ticketType,
        p.title,
        p.description ?? '',
        p.status,
        p.priority,
        p.parentId ? human.get(p.parentId) ?? null : null,
        p.branch ?? null,
        p.prUrl ?? null,
        p.assignee ?? null,
        JSON.stringify(p.labels ?? []),
        e.ts,
        e.ts
      );
      return 1;
    }

    case 'ticket.set_field': {
      const id = human.get(p.ticketId);
      if (!id) return 0; // ticket never created (or already a tombstone) — skip
      const column = FIELD_TO_COLUMN[p.field];
      if (!column) return 0;
      // Translate value back into DB storage form.
      let value;
      if (p.field === 'labels') value = JSON.stringify(p.value ?? []);
      else if (p.field === 'parentId') value = p.value ? human.get(p.value) ?? null : null;
      else value = p.value;

      // Reconstruct ticket_history so the audit feed survives replay: read the
      // current value as old_value before overwriting.
      const row = db.prepare(`SELECT ${column} AS v FROM tickets WHERE id = ?`).get(id);
      if (!row) return 0; // tombstoned — terminal, ignore later edits
      const oldValue = row.v;
      db.prepare(`UPDATE tickets SET ${column} = ?, updated_at = ? WHERE id = ?`).run(
        value,
        e.ts,
        id
      );
      db.prepare(
        `INSERT INTO ticket_history (ticket_id, field, old_value, new_value, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        column,
        oldValue == null ? null : String(oldValue),
        value == null ? null : String(value),
        e.actor,
        e.ts
      );
      return 1;
    }

    case 'ticket.delete': {
      const id = human.get(p.ticketId);
      if (id) db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
      return 1;
    }

    case 'comment.add': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      db.prepare(
        `INSERT INTO ticket_comments (ticket_id, author, body, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(id, p.author ?? null, p.body, e.ts);
      return 1;
    }

    case 'relation.add': {
      const from = human.get(p.fromId);
      const to = human.get(p.toId);
      if (!from || !to) return 0;
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO ticket_relations (from_ticket_id, to_ticket_id, type, created_at)
         VALUES (?, ?, ?, ?)`
      );
      stmt.run(from, to, p.type, e.ts);
      stmt.run(to, from, inverse(p.type), e.ts);
      return 1;
    }

    case 'relation.remove': {
      const from = human.get(p.fromId);
      const to = human.get(p.toId);
      if (!from || !to) return 0;
      db.prepare(
        `DELETE FROM ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?`
      ).run(from, to, p.type);
      db.prepare(
        `DELETE FROM ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?`
      ).run(to, from, inverse(p.type));
      return 1;
    }

    default:
      return 0;
  }
}

function inverse(type) {
  return RELATION_INVERSE[type];
}

/**
 * Convenience: open (and migrate) the db in `scopeDir` and rebuild it from the
 * on-disk event log. Returns the open db handle.
 */
export function rebuildScopeDb(scopeDir = findScopeDir() || defaultScopeDir()) {
  const db = openDb(scopeDir);
  const events = readAllEvents(eventsDir(scopeDir));
  replayInto(db, events);
  return db;
}
