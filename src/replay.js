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
import { compareEvents, formatActor } from './event-schema.js';
import { resolveDisplayNumbers, nextNumberSeed } from './identity.js';
import { readAllEvents, eventsDir, logHasInit } from './event-store.js';
import { COLUMN_TO_FIELD, RELATION_INVERSE } from './enums.js';
import { normalizeColumns } from './columns.js';
// SCP-219: tail-append decision helpers shared with the PG fast path.
import { isTailAppend, canonicalMax } from './pg/incremental.js';

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
 * SAFETY: only rebuilds from an *authoritative* log (one containing
 * workspace.init — see logHasInit). A partial/non-authoritative log never
 * triggers a rebuild, so a stray set of events can't wipe a populated cache.
 * ensureEventLog() must run first to make the log authoritative.
 *
 * @returns {{ rebuilt: boolean, count: number }}
 */
export function syncFromLog(db, scopeDir) {
  const diskCount = countEventFiles(scopeDir);
  if (!logHasInit(eventsDir(scopeDir))) return { rebuilt: false, count: diskCount };
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
 * Resolve the canonical display-number assignments + uid->humanId map for an
 * ordered event set, applying the SCP-118 rekey override. Pure (no DB I/O); used
 * by both the full replay and the SCP-219 incremental apply so the two compute
 * identical projections.
 *
 * @param {Array<object>} ordered - events already sorted by compareEvents
 * @returns {{ assignments: Map, renumbered: Array, human: Map<string,string>, rekeyTo: string|null }}
 */
function resolveProjection(ordered) {
  const { assignments, renumbered } = resolveDisplayNumbers(ordered);

  // A workspace.rekey reprefixes ALL tickets to a new key (SCP-118). The last
  // rekey in canonical order wins; override every assignment's display prefix so
  // the human id becomes TO-<number>.
  let rekeyTo = null;
  for (const e of ordered) if (e.kind === 'workspace.rekey') rekeyTo = e.payload.to;
  if (rekeyTo) {
    for (const a of assignments.values()) {
      a.keyPrefix = rekeyTo;
      a.humanId = `${rekeyTo}-${a.number}`;
    }
  }

  // uid -> human KEY-N id (the value the tickets table keys on). Translates the
  // ULID references in events back into the DB's human ids.
  const human = new Map();
  for (const [uid, a] of assignments) human.set(uid, a.humanId);

  return { assignments, renumbered, human, rekeyTo };
}

/**
 * Apply `ordered` events (already sorted) onto `db` using the precomputed
 * projection. Shared loop body for the full replay and the SCP-219 incremental
 * apply. Returns { applied, wsKey } where wsKey is the last workspace key seen
 * in this batch (null if none) so the caller can advance the workspace row.
 */
function applyEventLoop(db, ordered, human, assignments) {
  let wsKey = null;
  let applied = 0;
  for (const e of ordered) {
    applied += applyEvent(db, e, human, assignments);
    if (e.kind === 'workspace.init' || e.kind === 'workspace.set') {
      if (typeof e.payload.key === 'string') wsKey = e.payload.key;
    } else if (e.kind === 'workspace.rekey') {
      wsKey = e.payload.to; // the workspace key follows the rekey
    }
  }
  return { applied, wsKey };
}

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
  const { assignments, renumbered, human } = resolveProjection(ordered);

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    // Clear derived state. The workspace row (singleton) is updated in place.
    db.exec(`
      DELETE FROM ticket_history;
      DELETE FROM ticket_comments;
      DELETE FROM ticket_relations;
      DELETE FROM tickets;
    `);

    const { applied, wsKey } = applyEventLoop(db, ordered, human, assignments);

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

/**
 * Incremental replay (SCP-219). Apply ONLY `newEvents` onto the existing cache
 * when the batch is a pure tail-append, instead of wiping + re-applying the
 * whole log. `allEvents` is the full post-batch log (new events included); the
 * existing applied set is `allEvents \ newEvents`.
 *
 * The fast path is taken iff:
 *   1. every new event sorts strictly after the canonical max of the existing
 *      applied events (isTailAppend — the ordering half of the invariant), AND
 *   2. no new `ticket.create` claims a display number already assigned to an
 *      existing ticket (the collision half — a duplicate would force SCP-110
 *      renumbering of existing rows, which is NOT a clean append).
 * Otherwise we fall back to a FULL `replayInto(db, allEvents)` — the
 * always-correct ground truth (a golden test pins incremental == full).
 *
 * Correctness note: because the batch is a tail-append with no collision,
 * re-resolving display numbers over the FULL ordered set leaves every EXISTING
 * ticket's number/humanId unchanged, so the rows already in the cache stay
 * valid and the new events fold on with the correct uid->humanId mapping (which
 * must cover existing tickets that new events reference). We compute the
 * projection over the full set (pure, cheap) but only WRITE the new events.
 *
 * @param {Database} db - open better-sqlite3 handle (schema migrated)
 * @param {Array<object>} allEvents - the full log after the batch (any order)
 * @param {Array<object>} newEvents - the freshly-appended events (any order)
 * @returns {{ applied: number, renumbered: Array, incremental: boolean }}
 */
export function applyEvents(db, allEvents, newEvents) {
  if (!Array.isArray(newEvents) || newEvents.length === 0) {
    // Nothing new to fold on; the cache already reflects allEvents.
    return { applied: 0, renumbered: [], incremental: true };
  }

  // Derive the existing (already-applied) set = allEvents minus newEvents.
  const newIds = new Set(newEvents.map((e) => e.id));
  const existing = allEvents.filter((e) => !newIds.has(e.id));
  const existingMax = canonicalMax(existing);

  // SCP-219: incremental is an optimization over a POPULATED, consistent cache.
  // From an empty existing log there is nothing to save (full replay of a tiny
  // log is cheap) and, crucially, the incremental fold would assume the cache is
  // already in sync with `existing` — but an empty log can sit beside a stale
  // cache (e.g. a tenant whose events were cleared without wiping the cache), and
  // folding onto stale rows is unsafe. So always full-replay the first push.
  // Ordering half of the invariant (pure) is only consulted when there's a tail
  // to append to.
  let fastPath = existing.length > 0 && isTailAppend(existingMax, newEvents);

  // Collision half: a new ticket.create whose resolved number duplicates a
  // number already assigned to an existing ticket forces a renumber → NOT a
  // clean append. Compare the canonical assignment of the existing set against
  // the new creates' requested numbers.
  if (fastPath) {
    const existingNumbers = new Set();
    for (const a of resolveDisplayNumbers(existing).assignments.values()) {
      existingNumbers.add(a.number);
    }
    for (const e of newEvents) {
      if (e.kind === 'ticket.create' && existingNumbers.has(e.payload.number)) {
        fastPath = false; // collision → fall back to full replay
        break;
      }
    }
  }

  if (!fastPath) {
    // Fall back to the ground-truth full replay (SCP-219: when in doubt, full).
    const { applied, renumbered } = replayInto(db, allEvents);
    return { applied, renumbered, incremental: false };
  }

  // Fast path: fold only the new events onto the existing cache. The projection
  // is computed over the FULL ordered set so existing tickets the new events
  // reference resolve to their already-cached humanIds (unchanged by a clean
  // tail-append), but only the new events are WRITTEN to the db.
  const orderedAll = allEvents.slice().sort(compareEvents);
  const { assignments, renumbered, human } = resolveProjection(orderedAll);
  const orderedNew = newEvents.slice().sort(compareEvents);

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    const { applied, wsKey } = applyEventLoop(db, orderedNew, human, assignments);

    // Orphan cleanup: a new ticket.delete must cascade to its comments/relations
    // (mirrors the FK CASCADE), and any new relation/comment whose ticket was
    // tombstoned earlier must be dropped — same invariant the full replay holds.
    db.exec(`
      DELETE FROM ticket_comments WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM ticket_relations
        WHERE from_ticket_id NOT IN (SELECT id FROM tickets)
           OR to_ticket_id   NOT IN (SELECT id FROM tickets);
      DELETE FROM ticket_history WHERE ticket_id NOT IN (SELECT id FROM tickets);
    `);

    // Advance the allocator past every assigned number (resolved over the full
    // set, so it never regresses below what the full replay would set).
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
    throw new Error(`incremental replay left FK violations: ${JSON.stringify(issues)}`);
  }
  return { applied, renumbered, incremental: true };
}

function applyEvent(db, e, human, assignments) {
  const p = e.payload;
  switch (e.kind) {
    case 'workspace.init':
    case 'workspace.set': {
      const cols = ['key', 'name', 'description', 'overview', 'columns'].filter((k) => k in p);
      if (cols.length) {
        const sets = cols.map((c) => `${c} = ?`).join(', ');
        db.prepare(`UPDATE workspace SET ${sets} WHERE id = 1`).run(...cols.map((c) => (
          c === 'columns' ? JSON.stringify(normalizeColumns(p[c])) : p[c]
        )));
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
      // SCP-243: `rank` is cosmetic ordering — apply it to the cache but keep it
      // out of the audit history (matching updateTicket, so live and replayed
      // state agree and reorders never bloat the history view).
      if (p.field !== 'rank') {
        db.prepare(
          `INSERT INTO ticket_history (ticket_id, field, old_value, new_value, changed_by, changed_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          column,
          oldValue == null ? null : String(oldValue),
          value == null ? null : String(value),
          formatActor(e.actor, e.model),
          e.ts
        );
      }
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
      ).run(id, p.author == null ? null : formatActor(p.author, e.model), p.body, e.ts);
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
 * @param {string} [scopeDir]
 * @returns {import('./types.js').Database}
 */
export function rebuildScopeDb(scopeDir = findScopeDir() || defaultScopeDir()) {
  const db = openDb(scopeDir);
  const events = readAllEvents(eventsDir(scopeDir));
  replayInto(db, events);
  return db;
}
