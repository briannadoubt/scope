/**
 * Backfill — synthesize an event log from an existing pre-event-sourcing
 * database so upgrading users lose nothing (SCP-113).
 *
 * A DB created before SCP-108 has tickets/relations/comments/history rows but
 * no `.scope/events/`. backfillEvents() reconstructs an append-only log whose
 * replay reproduces the *current* board:
 *   - workspace.init from the workspace row
 *   - ticket.create with each ticket's INITIAL field values (recovered from the
 *     old_value of the first history entry per field), then one ticket.set_field
 *     per history row to walk it forward to the current value — so both the
 *     current state and the audit trail survive.
 *   - comment.add / relation.add for existing comments and relations.
 *
 * Idempotent: a no-op if the log already exists. Runs automatically on first
 * open via ensureEventLog().
 */

import { getWorkspace, setMeta } from './db.js';
import { makeEvent } from './event-schema.js';
import { appendEvent, eventsDir, logHasInit } from './event-store.js';
import { rmSync } from 'node:fs';
import { ulid } from './ulid.js';
import { COLUMN_TO_FIELD, RELATION_INVERSE } from './enums.js';

// Columns that appear in ticket_history (all map to an event field).
const HISTORY_COLUMNS = Object.keys(COLUMN_TO_FIELD);

/**
 * Ensure the event log is the authoritative source of truth for `scopeDir`.
 *
 * Authority is signalled by a `workspace.init` event in the log (see
 * logHasInit). If the log is already authoritative, this is a no-op. Otherwise
 * the DB is still the source of truth (a pre-event-sourcing upgrade, or a stray
 * partial log), so we bootstrap a *complete* log from the DB.
 *
 * This is the safety boundary that prevents data loss: syncFromLog only ever
 * rebuilds the cache from an authoritative log, and the only way a log becomes
 * authoritative is a complete backfill from the DB (or a fresh init).
 *
 * @returns {{ skipped: boolean, written?: number, reason?: string }}
 */
export function ensureEventLog(db, scopeDir) {
  if (logHasInit(eventsDir(scopeDir))) return { skipped: true, reason: 'log is authoritative' };
  return backfillEvents(db, scopeDir);
}

/**
 * Synthesize and write the event log from the current DB state. Builds and
 * validates every event in memory first (makeEvent throws on anything
 * malformed), then writes them — so a validation failure can't leave a partial
 * log on disk.
 */
export function backfillEvents(db, scopeDir, { actor = 'migration' } = {}) {
  const dir = eventsDir(scopeDir);
  const ws = getWorkspace(db);

  const tickets = db
    .prepare('SELECT * FROM tickets ORDER BY created_at ASC, id ASC')
    .all();

  // KEY-N id -> stable ULID, for translating parent/relation references.
  const uidById = new Map(tickets.map((t) => [t.id, t.uid]));

  const events = [];
  const add = (kind, payload, ts, who) =>
    events.push(makeEvent(kind, payload, { actor: who || actor, ts }));

  // 1. workspace.init
  add(
    'workspace.init',
    { key: ws.key, name: ws.name, description: ws.description ?? '', overview: ws.overview ?? '' },
    ws.created_at
  );

  // 2. tickets: create (initial state) + set_field per history row
  const historyStmt = db.prepare(
    `SELECT field, old_value, new_value, changed_by, changed_at
     FROM ticket_history WHERE ticket_id = ? ORDER BY changed_at ASC, id ASC`
  );
  for (const t of tickets) {
    const history = historyStmt.all(t.id);
    const firstChange = {};
    for (const h of history) if (!(h.field in firstChange)) firstChange[h.field] = h;

    // Initial value of a column: the old_value of its first history row if the
    // column was ever changed, else the current row value.
    const initial = (col) => (col in firstChange ? firstChange[col].old_value : t[col]);

    const keyPrefix = prefixOf(t.id, ws.key);
    add(
      'ticket.create',
      {
        ticketId: t.uid,
        number: t.number,
        keyPrefix,
        ticketType: t.type,
        title: initial('title') ?? t.title,
        description: initial('description') ?? '',
        status: initial('status') ?? t.status,
        priority: initial('priority') ?? t.priority,
        parentId: toUid(uidById, initial('parent_id')),
        branch: initial('branch') ?? null,
        prUrl: initial('pr_url') ?? null,
        assignee: initial('assignee') ?? null,
        labels: parseLabels(initial('labels')),
      },
      t.created_at
    );

    // Walk the recorded history, tracking where each column lands.
    const walked = {};
    for (const col of HISTORY_COLUMNS) walked[col] = initial(col);
    // SCP-243: `rank` is deliberately absent from ticket.create and never
    // recorded in ticket_history (reorders are cosmetic). Replay therefore
    // starts it at null, so seed the baseline as null — the reconcile pass
    // below then emits a single set_field carrying the ticket's live rank.
    walked.rank = null;
    for (const h of history) {
      if (!HISTORY_COLUMNS.includes(h.field)) continue;
      walked[h.field] = h.new_value;
      add(
        'ticket.set_field',
        { ticketId: t.uid, field: COLUMN_TO_FIELD[h.field], value: fieldValue(h.field, h.new_value, uidById) },
        h.changed_at,
        h.changed_by
      );
    }

    // Reconcile: some DBs have a current value that history doesn't end on (an
    // older code path changed a field without recording history). Emit a final
    // set_field to the CURRENT value for any such column so replay always
    // reproduces the live board, not a stale history tail.
    for (const col of HISTORY_COLUMNS) {
      if (normalizeCol(col, walked[col]) !== normalizeCol(col, t[col])) {
        add(
          'ticket.set_field',
          { ticketId: t.uid, field: COLUMN_TO_FIELD[col], value: fieldValue(col, t[col], uidById) },
          t.updated_at
        );
      }
    }
  }

  // 3. comments
  const comments = db
    .prepare('SELECT ticket_id, author, body, created_at FROM ticket_comments ORDER BY created_at ASC, id ASC')
    .all();
  for (const c of comments) {
    const uid = uidById.get(c.ticket_id);
    if (!uid) continue;
    add('comment.add', { ticketId: uid, commentId: ulid(), author: c.author ?? null, body: c.body }, c.created_at, c.author);
  }

  // 4. relations — dedup the stored bidirectional pairs into one intent each.
  const relations = db
    .prepare('SELECT from_ticket_id, to_ticket_id, type, created_at FROM ticket_relations ORDER BY created_at ASC, id ASC')
    .all();
  const seen = new Set();
  for (const r of relations) {
    const fromUid = uidById.get(r.from_ticket_id);
    const toUid = uidById.get(r.to_ticket_id);
    if (!fromUid || !toUid) continue;
    const key = `${r.from_ticket_id}|${r.to_ticket_id}|${r.type}`;
    const mirror = `${r.to_ticket_id}|${r.from_ticket_id}|${RELATION_INVERSE[r.type]}`;
    if (seen.has(key) || seen.has(mirror)) continue;
    seen.add(key);
    add('relation.add', { fromId: fromUid, toId: toUid, type: r.type }, r.created_at);
  }

  // All events validated during construction (makeEvent throws on bad input);
  // now publish the log atomically-ish. Clear any stray partial events first —
  // the DB is the source of truth here, so a complete backfill replaces, rather
  // than appends to, whatever incomplete events were lying around. This is what
  // makes the log authoritative (it now contains workspace.init).
  rmSync(dir, { recursive: true, force: true });
  for (const e of events) appendEvent(dir, e);
  // The db already reflects these events (they were synthesized from it), so
  // record the count — a later open won't needlessly rebuild (SCP-111).
  setMeta(db, 'applied_event_count', events.length);
  return { skipped: false, written: events.length };
}

function prefixOf(id, fallbackKey) {
  const prefix = String(id).split('-')[0];
  return /^[A-Z][A-Z0-9]{1,9}$/.test(prefix) ? prefix : fallbackKey;
}

/** Normalize a column value for equality comparison (history string vs row value). */
function normalizeCol(col, val) {
  if (col === 'labels') return JSON.stringify(parseLabels(val));
  return val == null ? '' : String(val);
}

function toUid(uidById, keyN) {
  return keyN ? uidById.get(keyN) ?? null : null;
}

function parseLabels(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function fieldValue(column, rawNewValue, uidById) {
  if (column === 'labels') return parseLabels(rawNewValue);
  if (column === 'parent_id') return toUid(uidById, rawNewValue);
  return rawNewValue;
}
