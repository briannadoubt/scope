import { nowIso, nextTicketId, recordHistory, getWorkspace } from './db.js';
import { emitChange } from './events.js';

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

export function updateWorkspace(db, fields = {}) {
  const ws = getWorkspace(db);
  const allowed = ['key', 'name', 'description', 'overview'];
  const updates = [];
  const values = [];
  for (const k of allowed) {
    if (k in fields) {
      if (k === 'key' && !/^[A-Z][A-Z0-9]{1,9}$/.test(fields[k])) {
        throw new Error(
          `Invalid workspace key "${fields[k]}" — use 2-10 uppercase letters/digits, e.g. "SCP".`
        );
      }
      updates.push(`${k} = ?`);
      values.push(fields[k]);
    }
  }
  if (!updates.length) return ws;
  updates.push('updated_at = ?');
  values.push(nowIso());
  db.prepare(`UPDATE workspace SET ${updates.join(', ')} WHERE id = 1`).run(...values);
  const updated = getWorkspace(db);
  emitChange({ type: 'workspace.updated', id: 1 });
  return updated;
}

/* ---------------- tickets ---------------- */

const TICKET_TYPES = new Set(['epic', 'story', 'bug']);
const STATUSES = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

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
  }
) {
  if (!TICKET_TYPES.has(type)) throw new Error(`Invalid type "${type}". Use epic|story|bug.`);
  if (!STATUSES.includes(status)) throw new Error(`Invalid status "${status}".`);
  if (!PRIORITIES.includes(priority)) throw new Error(`Invalid priority "${priority}".`);
  if (!title || !title.trim()) throw new Error('Ticket title is required.');

  let parentId = null;
  if (parent) {
    const parentTicket = getTicket(db, parent);
    if (!parentTicket) throw new Error(`Parent ticket not found: ${parent}`);
    if (parentTicket.type !== 'epic')
      throw new Error(`Parent must be an epic, got "${parentTicket.type}" (${parentTicket.id}).`);
    if (type === 'epic') throw new Error('Epics cannot have an epic parent.');
    parentId = parentTicket.id;
  }

  const { id, number } = nextTicketId(db);
  const now = nowIso();
  db.prepare(
    `INSERT INTO tickets
       (id, number, type, title, description, status, priority,
        parent_id, branch, pr_url, assignee, labels, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
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
  emitChange({ type: 'ticket.created', id });
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
  for (const k of allowed) {
    if (k in fields) {
      const v = k === 'labels' ? JSON.stringify(fields[k] ?? []) : fields[k];
      updates.push(`${k} = ?`);
      values.push(v);
      const oldRaw = k === 'labels' ? JSON.stringify(ticket[k] ?? []) : ticket[k];
      recordHistory(db, ticket.id, k, oldRaw, v, who);
    }
  }
  if (!updates.length) return ticket;
  updates.push('updated_at = ?');
  values.push(nowIso());
  values.push(ticket.id);
  db.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const after = getTicket(db, ticket.id);
  emitChange({ type: 'ticket.updated', id: ticket.id });
  return after;
}

export function deleteTicket(db, id) {
  const t = getTicket(db, id);
  if (!t) return false;
  db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
  emitChange({ type: 'ticket.deleted', id: t.id });
  return true;
}

/* ---------------- relations ---------------- */

const RELATION_TYPES = ['blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicate_of'];
const INVERSE = {
  blocks: 'blocked_by',
  blocked_by: 'blocks',
  relates_to: 'relates_to',
  duplicates: 'duplicate_of',
  duplicate_of: 'duplicates',
};

export function addRelation(db, fromId, toId, type) {
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
    stmt.run(to.id, from.id, INVERSE[type], now);
  });
  tx();
  emitChange({ type: 'relation.added', from: from.id, to: to.id, relType: type });
  return listRelations(db, from.id);
}

export function removeRelation(db, fromId, toId, type) {
  if (!RELATION_TYPES.includes(type)) throw new Error(`Invalid relation type "${type}".`);
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?`
    ).run(fromId, toId, type);
    db.prepare(
      `DELETE FROM ticket_relations WHERE from_ticket_id = ? AND to_ticket_id = ? AND type = ?`
    ).run(toId, fromId, INVERSE[type]);
  });
  tx();
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
  emitChange({ type: 'comment.added', id: t.id });
  return { id: res.lastInsertRowid, ticket_id: t.id, author, body };
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

export const SCHEMA_STATUSES = STATUSES;
export const SCHEMA_PRIORITIES = PRIORITIES;
export const SCHEMA_RELATION_TYPES = RELATION_TYPES;
export const SCHEMA_TICKET_TYPES = [...TICKET_TYPES];
