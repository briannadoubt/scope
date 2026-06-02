import { nowIso, nextTicketId, recordHistory, getWorkspace, bumpMeta } from './db.js';
import { emitChange } from './events.js';
import { ulid } from './ulid.js';
import { makeEvent } from './event-schema.js';
import { appendEvent, eventsDirForDb } from './event-store.js';
import {
  TICKET_TYPES,
  STATUSES,
  PRIORITIES,
  RELATION_TYPES,
  RELATION_INVERSE,
  COLUMN_TO_FIELD,
} from './enums.js';

/* ---------------- event emission (SCP-108) ---------------- */

/** Normalize an actor handle; every event must record a non-empty actor. */
const actorOf = (a) => (a && String(a).trim()) || 'unknown';

/**
 * Append one operation event to the on-disk log for this db's workspace. This
 * is the single chokepoint: every mutation below emits through here, so the
 * event log is a complete record of state changes (the future source of truth,
 * SCP-106). Today it runs alongside the SQLite writes (dual-write); SCP-109/111
 * flip the db to be a projection of this log.
 */
function emit(db, kind, payload, actor) {
  const evt = appendEvent(eventsDirForDb(db), makeEvent(kind, payload, { actor: actorOf(actor) }));
  // Keep the cache's applied-count in step with the log so a subsequent open
  // doesn't think the db is stale and rebuild it (SCP-111).
  bumpMeta(db, 'applied_event_count', 1);
  return evt;
}

/** Look up a ticket's stable ULID identity by its KEY-N id. */
function uidFor(db, id) {
  return db.prepare('SELECT uid FROM tickets WHERE id = ?').get(id)?.uid ?? null;
}

/* ---------------- workspace ---------------- */

/**
 * Update the singleton workspace row. The row itself is created by the
 * db.js migration/init step, so this is purely an UPDATE.
 *
 * Accepts: { key, name, description, overview } — any subset.
 */
export function setWorkspace(db, fields = {}) {
  return updateWorkspace(db, fields);
}

export { getWorkspace };

/**
 * Back-compat shim: the v1 API exposed listProjects(). The v2 workspace
 * is a singleton, so this returns a one-element array. The API layer can
 * keep returning a list to old clients.
 */
export function listWorkspaces(db) {
  try {
    return [getWorkspace(db)];
  } catch {
    return [];
  }
}

export function updateWorkspace(db, fields = {}, who = null) {
  const ws = getWorkspace(db);
  const allowed = ['key', 'name', 'description', 'overview'];
  const updates = [];
  const values = [];
  const changed = {};
  for (const k of allowed) {
    if (k in fields) {
      if (k === 'key' && !/^[A-Z][A-Z0-9]{1,9}$/.test(fields[k])) {
        throw new Error(
          `Invalid workspace key "${fields[k]}" — use 2-10 uppercase letters/digits, e.g. "SCP".`
        );
      }
      updates.push(`${k} = ?`);
      values.push(fields[k]);
      changed[k] = fields[k];
    }
  }
  if (!updates.length) return ws;
  updates.push('updated_at = ?');
  values.push(nowIso());
  db.prepare(`UPDATE workspace SET ${updates.join(', ')} WHERE id = 1`).run(...values);
  const updated = getWorkspace(db);
  emit(db, 'workspace.set', changed, who);
  emitChange({ type: 'workspace.updated', id: 1 });
  return updated;
}

/* ---------------- tickets ---------------- */

export function createTicket(
  db,
  {
    type,
    title,
    description = '',
    status = 'backlog',
    priority = 'medium',
    parent,
    branch,
    prUrl,
    assignee,
    labels = [],
    actor,
  }
) {
  if (!TICKET_TYPES.includes(type)) throw new Error(`Invalid type "${type}". Use epic|story|bug.`);
  if (!STATUSES.includes(status)) throw new Error(`Invalid status "${status}".`);
  if (!PRIORITIES.includes(priority)) throw new Error(`Invalid priority "${priority}".`);
  if (!title || !title.trim()) throw new Error('Ticket title is required.');

  let parentId = null;
  let parentUid = null;
  if (parent) {
    const parentTicket = getTicket(db, parent);
    if (!parentTicket) throw new Error(`Parent ticket not found: ${parent}`);
    if (parentTicket.type !== 'epic')
      throw new Error(`Parent must be an epic, got "${parentTicket.type}" (${parentTicket.id}).`);
    if (type === 'epic') throw new Error('Epics cannot have an epic parent.');
    parentId = parentTicket.id;
    parentUid = parentTicket.uid;
  }

  const { id, number } = nextTicketId(db);
  const uid = ulid();
  const now = nowIso();
  db.prepare(
    `INSERT INTO tickets
       (id, uid, number, type, title, description, status, priority,
        parent_id, branch, pr_url, assignee, labels, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    uid,
    number,
    type,
    title,
    description,
    status,
    priority,
    parentId,
    branch ?? null,
    prUrl ?? null,
    assignee ?? null,
    JSON.stringify(labels ?? []),
    now,
    now
  );
  const created = getTicket(db, id);
  emit(
    db,
    'ticket.create',
    {
      ticketId: uid,
      number,
      keyPrefix: getWorkspace(db).key,
      ticketType: type,
      title,
      description,
      status,
      priority,
      parentId: parentUid,
      branch: branch ?? null,
      prUrl: prUrl ?? null,
      assignee: assignee ?? null,
      labels: labels ?? [],
    },
    actor
  );
  emitChange({
    type: 'ticket.created',
    id,
    title: created.title,
    ticket_type: created.type,
    status: created.status,
    priority: created.priority,
  });
  return created;
}

export function getTicket(db, id) {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  if (!row) return null;
  return hydrateTicket(row);
}

function hydrateTicket(row) {
  return {
    ...row,
    labels: safeParseJson(row.labels, []),
  };
}

function safeParseJson(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

export function listTickets(db, { type, status, parentId, assignee } = {}) {
  const where = [];
  const params = [];
  if (type) {
    where.push('type = ?');
    params.push(type);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (parentId !== undefined) {
    if (parentId === null) where.push('parent_id IS NULL');
    else {
      where.push('parent_id = ?');
      params.push(parentId);
    }
  }
  if (assignee) {
    where.push('assignee = ?');
    params.push(assignee);
  }
  const sql = `SELECT * FROM tickets ${
    where.length ? 'WHERE ' + where.join(' AND ') : ''
  } ORDER BY number`;
  return db.prepare(sql).all(...params).map(hydrateTicket);
}

export function updateTicket(db, id, fields, who = null) {
  const ticket = getTicket(db, id);
  if (!ticket) throw new Error(`Ticket not found: ${id}`);

  const allowed = [
    'title',
    'description',
    'status',
    'priority',
    'parent_id',
    'branch',
    'pr_url',
    'assignee',
    'labels',
  ];

  if ('status' in fields && !STATUSES.includes(fields.status))
    throw new Error(`Invalid status "${fields.status}". One of: ${STATUSES.join(', ')}`);
  if ('priority' in fields && !PRIORITIES.includes(fields.priority))
    throw new Error(`Invalid priority "${fields.priority}". One of: ${PRIORITIES.join(', ')}`);

  if ('parent_id' in fields && fields.parent_id) {
    const parent = getTicket(db, fields.parent_id);
    if (!parent) throw new Error(`Parent ticket not found: ${fields.parent_id}`);
    if (parent.type !== 'epic')
      throw new Error(`Parent must be an epic, got "${parent.type}".`);
    if (parent.id === ticket.id) throw new Error('A ticket cannot be its own parent.');
    if (ticket.type === 'epic') throw new Error('Epics cannot have a parent.');
    fields.parent_id = parent.id;
  }

  const updates = [];
  const values = [];
  // Collect (field, oldRaw, newRaw) tuples so we can emit one rich
  // ticket.updated event per field after the row is rewritten — same shape
  // the fs-watch fallback produces from ticket_history rows.
  const fieldChanges = [];
  // Collect ticket.set_field event payloads (one per changed column), translated
  // from DB columns to event field names / ULID references. Emitted after the
  // row write succeeds.
  const setFieldEvents = [];
  for (const k of allowed) {
    if (k in fields) {
      const v = k === 'labels' ? JSON.stringify(fields[k] ?? []) : fields[k];
      updates.push(`${k} = ?`);
      values.push(v);
      const oldRaw = k === 'labels' ? JSON.stringify(ticket[k] ?? []) : ticket[k];
      const historyId = recordHistory(db, ticket.id, k, oldRaw, v, who);
      if (historyId != null) {
        fieldChanges.push({ field: k, old: oldRaw, new: v, historyId });
        // Event value is the natural JSON type: array for labels, the parent's
        // ULID (not KEY-N) for parent_id, the raw value otherwise.
        let value;
        if (k === 'labels') value = fields[k] ?? [];
        else if (k === 'parent_id') value = fields.parent_id ? uidFor(db, fields.parent_id) : null;
        else value = fields[k];
        setFieldEvents.push({ field: COLUMN_TO_FIELD[k], value });
      }
    }
  }
  if (!updates.length) return ticket;
  updates.push('updated_at = ?');
  values.push(nowIso());
  values.push(ticket.id);
  db.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  for (const e of setFieldEvents) {
    emit(db, 'ticket.set_field', { ticketId: ticket.uid, field: e.field, value: e.value }, who);
  }
  const after = getTicket(db, ticket.id);
  // One toast-shaped event per field. If nothing actually changed value-wise
  // (recordHistory is a no-op for same-as-current), emit a single bare
  // ticket.updated so listeners still know to refresh.
  if (fieldChanges.length) {
    for (const change of fieldChanges) {
      emitChange({
        type: 'ticket.updated',
        id: ticket.id,
        title: after.title,
        field: change.field,
        old_value: change.old == null ? null : String(change.old),
        new_value: change.new == null ? null : String(change.new),
        changed_by: who,
        historyId: change.historyId,
      });
    }
  } else {
    emitChange({ type: 'ticket.updated', id: ticket.id, title: after.title });
  }
  return after;
}

export function deleteTicket(db, id, who = null) {
  const t = getTicket(db, id);
  if (!t) return false;
  db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
  emit(db, 'ticket.delete', { ticketId: t.uid }, who);
  emitChange({ type: 'ticket.deleted', id: t.id, title: t.title });
  return true;
}

/* ---------------- relations ---------------- */

export function addRelation(db, fromId, toId, type, who = null) {
  if (!RELATION_TYPES.includes(type))
    throw new Error(`Invalid relation type "${type}". One of: ${RELATION_TYPES.join(', ')}`);
  if (fromId === toId) throw new Error('Cannot relate a ticket to itself.');
  const from = getTicket(db, fromId);
  const to = getTicket(db, toId);
  if (!from) throw new Error(`Ticket not found: ${fromId}`);
  if (!to) throw new Error(`Ticket not found: ${toId}`);
  const now = nowIso();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ticket_relations (from_ticket_id, to_ticket_id, type, created_at)
     VALUES (?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    stmt.run(from.id, to.id, type, now);
    stmt.run(to.id, from.id, RELATION_INVERSE[type], now);
  });
  tx();
  // Emit the single user intent; replay materializes the inverse (SCP-110).
  emit(db, 'relation.add', { fromId: from.uid, toId: to.uid, type }, who);
  emitChange({ type: 'relation.added', from: from.id, to: to.id, relType: type });
  return listRelations(db, from.id);
}

export function removeRelation(db, fromId, toId, type, who = null) {
  if (!RELATION_TYPES.includes(type)) throw new Error(`Invalid relation type "${type}".`);
  const fromUid = uidFor(db, fromId);
  const toUid = uidFor(db, toId);
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?`
    ).run(fromId, toId, type);
    db.prepare(
      `DELETE FROM ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?`
    ).run(toId, fromId, RELATION_INVERSE[type]);
  });
  tx();
  if (fromUid && toUid) {
    emit(db, 'relation.remove', { fromId: fromUid, toId: toUid, type }, who);
  }
  emitChange({ type: 'relation.removed', from: fromId, to: toId, relType: type });
}

export function listRelations(db, ticketId) {
  return db
    .prepare(
      `SELECT r.type, r.to_ticket_id, t.title, t.status, t.type AS ticket_type
       FROM ticket_relations r
       LEFT JOIN tickets t ON t.id = r.to_ticket_id
       WHERE r.from_ticket_id = ?
       ORDER BY r.type, r.to_ticket_id`
    )
    .all(ticketId);
}

/* ---------------- comments & history ---------------- */

export function addComment(db, ticketId, body, author = null) {
  const t = getTicket(db, ticketId);
  if (!t) throw new Error(`Ticket not found: ${ticketId}`);
  const res = db
    .prepare(
      `INSERT INTO ticket_comments (ticket_id, author, body, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(t.id, author, body, nowIso());
  const commentId = Number(res.lastInsertRowid);
  emit(db, 'comment.add', { ticketId: t.uid, commentId: ulid(), author: author ?? null, body }, author);
  emitChange({
    type: 'comment.added',
    id: t.id,
    title: t.title,
    author,
    body,
    commentId,
  });
  return { id: commentId, ticket_id: t.id, author, body };
}

export function listComments(db, ticketId) {
  return db
    .prepare(
      `SELECT id, author, body, created_at FROM ticket_comments
       WHERE ticket_id = ? ORDER BY created_at ASC`
    )
    .all(ticketId);
}

export function listHistory(db, ticketId) {
  return db
    .prepare(
      `SELECT field, old_value, new_value, changed_by, changed_at
       FROM ticket_history WHERE ticket_id = ? ORDER BY changed_at ASC`
    )
    .all(ticketId);
}

/**
 * Workspace-wide history feed, newest first, with cursor-based pagination.
 * (In v1 this was project-scoped; v2 has a single workspace, so the feed
 * covers the whole DB.)
 *
 * @param {object} db
 * @param {object} [opts]
 * @param {number} [opts.limit=100]  - max rows to return (clamped to 1..500)
 * @param {string} [opts.before]     - ISO timestamp; only rows with
 *                                     changed_at strictly before this cursor.
 * @param {number} [opts.beforeId]   - id tiebreaker for the cursor.
 */
export function listWorkspaceHistory(db, opts = {}) {
  const rawLimit = Number(opts.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(500, Math.floor(rawLimit)))
    : 100;
  const params = [];
  let where = '';
  if (opts.before) {
    where = 'WHERE (h.changed_at < ? OR (h.changed_at = ? AND h.id < ?))';
    params.push(String(opts.before), String(opts.before));
    const beforeId = Number(opts.beforeId);
    params.push(Number.isFinite(beforeId) ? beforeId : Number.MAX_SAFE_INTEGER);
  }
  params.push(limit);
  return db
    .prepare(
      `SELECT h.id, h.ticket_id, t.title AS ticket_title, t.type AS ticket_type,
              h.field, h.old_value, h.new_value, h.changed_by, h.changed_at
       FROM ticket_history h
       JOIN tickets t ON t.id = h.ticket_id
       ${where}
       ORDER BY h.changed_at DESC, h.id DESC
       LIMIT ?`
    )
    .all(...params);
}

/* ---------------- epic helpers ---------------- */

export function listEpicChildren(db, epicId) {
  return db
    .prepare(
      `SELECT * FROM tickets WHERE parent_id = ? ORDER BY type, number`
    )
    .all(epicId)
    .map(hydrateTicket);
}

export function epicProgress(db, epicId) {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) as n FROM tickets WHERE parent_id = ? GROUP BY status`
    )
    .all(epicId);
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  let total = 0;
  for (const r of rows) {
    counts[r.status] = r.n;
    total += r.n;
  }
  return {
    total,
    counts,
    done: counts.done,
    percent: total ? Math.round((counts.done / total) * 100) : 0,
  };
}

/* ---------------- constants ---------------- */
// Re-exported from the canonical enums module for back-compat with callers that
// import SCHEMA_* from repo.js.
export const SCHEMA_STATUSES = STATUSES;
export const SCHEMA_PRIORITIES = PRIORITIES;
export const SCHEMA_RELATION_TYPES = RELATION_TYPES;
export const SCHEMA_TICKET_TYPES = TICKET_TYPES;
