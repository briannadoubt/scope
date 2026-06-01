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

/** Default / maximum result counts for search. */
export const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 200;

/**
 * Clamp a caller-supplied limit into [1, SEARCH_MAX_LIMIT]. Absent/garbage
 * values fall back to the default; an explicit 0 or negative clamps up to 1
 * (so the documented "1-200" range holds and the falsy-zero trap is avoided).
 * Tolerates Express handing us an array for a repeated `?limit=` query param.
 */
function clampSearchLimit(limit) {
  const raw = Array.isArray(limit) ? limit[0] : limit;
  const num = Number(raw);
  if (!Number.isFinite(num)) return SEARCH_DEFAULT_LIMIT;
  return Math.max(1, Math.min(SEARCH_MAX_LIMIT, Math.floor(num)));
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression.
 *
 * We deliberately ignore FTS5's own operator syntax (AND/OR/NEAR/quotes/`-`):
 * the input is split into tokens, each becomes a prefix term (`auth*`), and
 * they're joined with implicit AND so every token must match. Stripping to
 * `[\p{L}0-9]+` (Unicode letters + ASCII digits) means the query can never
 * inject FTS operators, and — crucially — it mirrors what the `unicode61`
 * tokenizer actually indexes: non-ASCII numerics/symbols (٧, ½, ², ⅷ) that the
 * tokenizer drops are excluded here too, so they can't turn into a no-match
 * term that silently zeroes out the whole AND. Returns null when there's
 * nothing searchable.
 */
function buildFtsMatch(query) {
  const tokens = String(query ?? '').toLowerCase().match(/[\p{L}0-9]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `${t}*`).join(' ');
}

/**
 * If the raw query is an exact ticket key ("SCP-7", case-insensitive) or a
 * bare ticket number ("7"), return that ticket so callers can float it to the
 * top. Without this, prefix matching makes "SCP-7"/"7" also return SCP-70,
 * SCP-71, … and the exact ticket can be buried — bad for the "jump to a
 * ticket by number" use case. Returns null when the query isn't an exact ref
 * or no such ticket exists.
 */
function exactTicketRef(db, raw) {
  const q = String(raw ?? '').trim();
  let row = null;
  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q)) {
    row = db.prepare('SELECT * FROM tickets WHERE id = ? COLLATE NOCASE').get(q);
  } else if (/^\d+$/.test(q)) {
    row = db.prepare('SELECT * FROM tickets WHERE number = ?').get(Number(q));
  }
  return row ? hydrateTicket(row) : null;
}

/**
 * Full-text search across every ticket field — id/key, number, title,
 * description, assignee, labels, branch, pr_url — and comment bodies, ranked
 * by relevance (FTS5 bm25, best match first). An exact key/number match is
 * floated to the top. Returns hydrated ticket rows in the same shape as
 * listTickets(). An empty / token-less query returns [].
 */
export function searchTickets(db, query, { limit } = {}) {
  const match = buildFtsMatch(query);
  if (!match) return [];
  const n = clampSearchLimit(limit);
  const rows = db
    .prepare(
      `SELECT t.*, bm25(tickets_fts) AS _score
       FROM tickets_fts
       JOIN tickets t ON t.id = tickets_fts.ticket_id
       WHERE tickets_fts MATCH ?
       ORDER BY _score ASC, t.number ASC
       LIMIT ?`
    )
    .all(match, n);
  let results = rows.map(({ _score, ...row }) => hydrateTicket(row));

  // Float an exact key/number hit to the front (deduped), so typing a full
  // ticket ref lands on that ticket even when prefix siblings rank higher.
  const exact = exactTicketRef(db, query);
  if (exact) {
    results = [exact, ...results.filter((t) => t.id !== exact.id)];
    if (results.length > n) results = results.slice(0, n);
  }
  return results;
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
  for (const k of allowed) {
    if (k in fields) {
      const v = k === 'labels' ? JSON.stringify(fields[k] ?? []) : fields[k];
      updates.push(`${k} = ?`);
      values.push(v);
      const oldRaw = k === 'labels' ? JSON.stringify(ticket[k] ?? []) : ticket[k];
      const historyId = recordHistory(db, ticket.id, k, oldRaw, v, who);
      if (historyId != null) {
        fieldChanges.push({ field: k, old: oldRaw, new: v, historyId });
      }
    }
  }
  if (!updates.length) return ticket;
  updates.push('updated_at = ?');
  values.push(nowIso());
  values.push(ticket.id);
  db.prepare(`UPDATE tickets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
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

export function deleteTicket(db, id) {
  const t = getTicket(db, id);
  if (!t) return false;
  db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
  emitChange({ type: 'ticket.deleted', id: t.id, title: t.title });
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
  const commentId = Number(res.lastInsertRowid);
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

export const SCHEMA_STATUSES = STATUSES;
export const SCHEMA_PRIORITIES = PRIORITIES;
export const SCHEMA_RELATION_TYPES = RELATION_TYPES;
export const SCHEMA_TICKET_TYPES = [...TICKET_TYPES];
