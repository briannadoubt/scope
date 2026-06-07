import { nowIso, nextTicketId, recordHistory, getWorkspace, bumpMeta, setMeta } from './db.js';
import { emitChange } from './events.js';
import { ulid } from './ulid.js';
import { makeEvent, formatActor } from './event-schema.js';
import { appendEvent, eventsDirForDb, readAllEvents } from './event-store.js';
import { replayInto } from './replay.js';
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

// When a batch is in flight (applyBatch), emitted events are buffered here and
// flushed to disk only after the DB transaction commits — so a batch is atomic
// across both the cache and the log (all events land, or none do).
let pendingEvents = null;

/**
 * Append one operation event to the on-disk log for this db's workspace. This
 * is the single chokepoint: every mutation below emits through here, so the
 * event log is a complete record of state changes (the source of truth,
 * SCP-106). Runs alongside the SQLite writes (dual-write).
 *
 * Inside applyBatch the event is buffered (not written) so the whole batch can
 * be flushed atomically after the transaction commits.
 */
function emit(db, kind, payload, actor, model = null) {
  const evt = makeEvent(kind, payload, { actor: actorOf(actor), model: model || undefined });
  if (pendingEvents) {
    pendingEvents.push(evt);
    return evt;
  }
  appendEvent(eventsDirForDb(db), evt);
  // Keep the cache's applied-count in step with the log so a subsequent open
  // doesn't think the db is stale and rebuild it (SCP-111).
  bumpMeta(db, 'applied_event_count', 1);
  return evt;
}

/** Look up a ticket's stable ULID identity by its KEY-N id. */
function uidFor(db, id) {
  return db.prepare('SELECT uid FROM tickets WHERE id = ?').get(id)?.uid ?? null;
}

/* ---------------- batch (atomic multi-op, SCP-116) ---------------- */

/**
 * Apply a list of operations atomically: they all succeed and their events are
 * written, or nothing changes (DB rolled back, no events written). This is the
 * supported way for an agent to do bulk/compound edits — there is never a reason
 * to touch scope.db directly.
 *
 * Each op is `{ op, ... }`:
 *   - { op: 'create', type, title, ..., ref? }   → createTicket; `ref` names the
 *       new ticket so later ops can reference it as "$ref" (e.g. parent).
 *   - { op: 'update', id, fields }               → updateTicket
 *   - { op: 'status', id, status }               → updateTicket status only
 *   - { op: 'delete', id }                        → deleteTicket
 *   - { op: 'comment', id, body, author? }        → addComment
 *   - { op: 'link', from, type, to }              → addRelation
 *   - { op: 'unlink', from, type, to }            → removeRelation
 *   - { op: 'workspace', fields }                 → updateWorkspace
 * Any `id`/`from`/`to`/`parent` value of the form "$name" is resolved to the id
 * of the ticket created earlier in the same batch under `ref: 'name'`.
 *
 * `model` is the acting-model attribution (SCP-128) applied to every op; an op
 * may override it with its own `model` (mirroring how `by` overrides `actor`).
 *
 * @returns {{ applied: number, results: Array, refs: object }}
 */
export function applyBatch(db, ops, { actor = null, model = null } = {}) {
  if (!Array.isArray(ops)) throw new Error('batch ops must be an array');
  if (pendingEvents) throw new Error('applyBatch cannot be nested');

  const refs = Object.create(null);
  const deref = (v) =>
    typeof v === 'string' && v.startsWith('$') ? resolveRef(refs, v.slice(1)) : v;

  pendingEvents = [];
  try {
    const results = db.transaction(() => {
      const out = [];
      ops.forEach((op, i) => {
        out.push(dispatchOp(db, op, i, actor, model, refs, deref));
      });
      return out;
    })();
    // Transaction committed — now publish the buffered events.
    const dir = eventsDirForDb(db);
    for (const evt of pendingEvents) appendEvent(dir, evt);
    if (pendingEvents.length) bumpMeta(db, 'applied_event_count', pendingEvents.length);
    return { applied: ops.length, results, refs: { ...refs } };
  } finally {
    // On error the DB transaction has already rolled back; dropping the buffer
    // means no events were written. Either way, clear batch state.
    pendingEvents = null;
  }
}

function resolveRef(refs, name) {
  if (!(name in refs)) throw new Error(`batch references unknown ref "$${name}"`);
  return refs[name];
}

function dispatchOp(db, op, i, actor, model, refs, deref) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string')
    throw new Error(`batch op #${i} must be an object with an "op" field`);
  const who = op.by || actor;
  const how = op.model || model;
  switch (op.op) {
    case 'create': {
      const t = createTicket(db, {
        type: op.type,
        title: op.title,
        description: op.description,
        status: op.status,
        priority: op.priority,
        parent: op.parent != null ? deref(op.parent) : undefined,
        branch: op.branch,
        prUrl: op.prUrl,
        assignee: op.assignee,
        labels: op.labels,
        actor: who,
        model: how,
      });
      if (op.ref) refs[op.ref] = t.id;
      return { op: 'create', id: t.id, ref: op.ref ?? null };
    }
    case 'update':
      return { op: 'update', id: deref(op.id), ticket: updateTicket(db, deref(op.id), op.fields ?? {}, who, how).id };
    case 'status':
      return { op: 'status', id: deref(op.id), ticket: updateTicket(db, deref(op.id), { status: op.status }, who, how).id };
    case 'delete':
      return { op: 'delete', id: deref(op.id), deleted: deleteTicket(db, deref(op.id), who, how) };
    case 'comment':
      return { op: 'comment', id: deref(op.id), comment: addComment(db, deref(op.id), op.body, who, how) };
    case 'link':
      addRelation(db, deref(op.from), deref(op.to), op.type, who, how);
      return { op: 'link', from: deref(op.from), to: deref(op.to), type: op.type };
    case 'unlink':
      removeRelation(db, deref(op.from), deref(op.to), op.type, who, how);
      return { op: 'unlink', from: deref(op.from), to: deref(op.to), type: op.type };
    case 'workspace':
      updateWorkspace(db, op.fields ?? {}, who, how);
      return { op: 'workspace', fields: op.fields ?? {} };
    default:
      throw new Error(`batch op #${i}: unknown op "${op.op}"`);
  }
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

export function updateWorkspace(db, fields = {}, who = null, model = null) {
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
  emit(db, 'workspace.set', changed, who, model);
  emitChange({ type: 'workspace.updated', id: 1 });
  return updated;
}

/**
 * Rekey the workspace: change the key AND reprefix every existing ticket's
 * display id (KEY-N -> NEWKEY-N) (SCP-118). Unlike `updateWorkspace({key})`
 * (which only affects future tickets), this rewrites the whole board.
 *
 * Emits a `workspace.rekey` event, then rebuilds the cache from the log so the
 * reprefixed ids are materialized consistently (parents, relations, comments
 * all follow, since they reference tickets by ULID in the log).
 *
 * @returns {{ key: string, reprefixed: number }}
 */
export function rekeyWorkspace(db, newKey, { actor = null, model = null } = {}) {
  if (pendingEvents) throw new Error('rekey cannot run inside a batch');
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(newKey))
    throw new Error(`Invalid key "${newKey}" — use 2-10 uppercase letters/digits, e.g. "SCP".`);
  const count = db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
  emit(db, 'workspace.rekey', { to: newKey }, actor, model);
  // Rebuild from the (now rekey-containing) log; replay reprefixes all ids.
  const events = readAllEvents(eventsDirForDb(db));
  replayInto(db, events);
  setMeta(db, 'applied_event_count', events.length);
  emitChange({ type: 'workspace.updated', id: 1 });
  return { key: newKey, reprefixed: count };
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
    model = null,
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
    // Epics may nest under other epics. A freshly created ticket has no
    // descendants yet, so it can't introduce a cycle here — only edits can
    // (see updateTicket).
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
    actor,
    model
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

export function updateTicket(db, id, fields, who = null, model = null) {
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
    // Epics may nest under other epics, but the parent chain must stay acyclic
    // — reparenting an epic under one of its own descendants would create a
    // loop that recursive walks (progress, swimlanes) never terminate on.
    if (ticket.type === 'epic') {
      let cursor = parent;
      const seen = new Set();
      while (cursor) {
        if (cursor.id === ticket.id)
          throw new Error(`Cannot nest ${ticket.id} under its own descendant ${parent.id}.`);
        if (seen.has(cursor.id)) break;
        seen.add(cursor.id);
        cursor = cursor.parent_id ? getTicket(db, cursor.parent_id) : null;
      }
    }
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
      const historyId = recordHistory(db, ticket.id, k, oldRaw, v, who, model);
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
    emit(db, 'ticket.set_field', { ticketId: ticket.uid, field: e.field, value: e.value }, who, model);
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
        changed_by: who == null ? null : formatActor(who, model),
        historyId: change.historyId,
      });
    }
  } else {
    emitChange({ type: 'ticket.updated', id: ticket.id, title: after.title });
  }
  return after;
}

export function deleteTicket(db, id, who = null, model = null) {
  const t = getTicket(db, id);
  if (!t) return false;
  db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
  emit(db, 'ticket.delete', { ticketId: t.uid }, who, model);
  emitChange({ type: 'ticket.deleted', id: t.id, title: t.title });
  return true;
}

/* ---------------- relations ---------------- */

export function addRelation(db, fromId, toId, type, who = null, model = null) {
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
  emit(db, 'relation.add', { fromId: from.uid, toId: to.uid, type }, who, model);
  emitChange({ type: 'relation.added', from: from.id, to: to.id, relType: type });
  return listRelations(db, from.id);
}

export function removeRelation(db, fromId, toId, type, who = null, model = null) {
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
    emit(db, 'relation.remove', { fromId: fromUid, toId: toUid, type }, who, model);
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

export function addComment(db, ticketId, body, author = null, model = null) {
  const t = getTicket(db, ticketId);
  if (!t) throw new Error(`Ticket not found: ${ticketId}`);
  // Cache stores the rendered attribution; the event keeps author + model
  // separate. With no model this is exactly the prior behavior (author as-is).
  const displayAuthor = author == null ? null : formatActor(author, model);
  const res = db
    .prepare(
      `INSERT INTO ticket_comments (ticket_id, author, body, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(t.id, displayAuthor, body, nowIso());
  const commentId = Number(res.lastInsertRowid);
  emit(db, 'comment.add', { ticketId: t.uid, commentId: ulid(), author: author ?? null, body }, author, model);
  emitChange({
    type: 'comment.added',
    id: t.id,
    title: t.title,
    author: displayAuthor,
    body,
    commentId,
  });
  return { id: commentId, ticket_id: t.id, author: displayAuthor, body };
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

/**
 * Ids of an epic and every epic nested beneath it (depth-first). Used so that
 * progress and descendant queries fold in work that lives under sub-epics, not
 * just the direct children.
 */
export function epicSubtreeIds(db, epicId) {
  const ids = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
    const childEpics = db
      .prepare(`SELECT id FROM tickets WHERE parent_id = ? AND type = 'epic'`)
      .all(id);
    for (const c of childEpics) walk(c.id);
  };
  walk(epicId);
  return ids;
}

/** Stories and bugs anywhere beneath an epic, including under nested epics. */
export function listEpicDescendants(db, epicId) {
  const ids = epicSubtreeIds(db, epicId);
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM tickets
       WHERE parent_id IN (${placeholders}) AND type != 'epic'
       ORDER BY type, number`
    )
    .all(...ids)
    .map(hydrateTicket);
}

export function epicProgress(db, epicId) {
  // Count the work items (stories/bugs) across the whole subtree so a parent
  // epic's progress reflects everything nested beneath it, not just its direct
  // children. Sub-epics are containers, not work, so they're excluded.
  const ids = epicSubtreeIds(db, epicId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) as n FROM tickets
       WHERE parent_id IN (${placeholders}) AND type != 'epic'
       GROUP BY status`
    )
    .all(...ids);
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
