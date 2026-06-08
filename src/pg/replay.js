/**
 * Postgres replay (SCP-141) — the hosted-node port of src/replay.js's
 * `replayInto`. Projects a tenant's event log into the multi-tenant cache
 * tables (SCP-140). Behaviorally identical to the SQLite replay (a golden test
 * asserts byte-identical board output for the same event set):
 *
 *  - canonical order via `compareEvents` (ts -> ULID id)
 *  - SCP-110 display-number de-collision via `resolveDisplayNumbers` (pure,
 *    reused verbatim — this is why server reconciliation == local replay)
 *  - workspace.rekey reprefixes every display id (SCP-118)
 *  - tombstone/orphan cleanup mirrors the SQLite FK-cascade behavior
 *  - history `changed_by` / comment `author` carry rendered attribution (SCP-128)
 *
 * Everything is scoped by `tenantId`; the SQLite singleton workspace (id=1)
 * becomes one workspace row per tenant.
 */
import { compareEvents, formatActor } from '../event-schema.js';
import { resolveDisplayNumbers, nextNumberSeed } from '../identity.js';
import { COLUMN_TO_FIELD, RELATION_INVERSE } from '../enums.js';

const FIELD_TO_COLUMN = Object.fromEntries(
  Object.entries(COLUMN_TO_FIELD).map(([col, field]) => [field, col])
);

/**
 * Replay `events` into a tenant's cache using an EXISTING transaction `client`.
 * Does NOT manage the transaction — the caller owns BEGIN/COMMIT — so it can be
 * composed atomically with an event-log insert (SCP-142 upload).
 *
 * @param {import('pg').PoolClient} client - a client with an open transaction
 * @param {string} tenantId
 * @param {Array<object>} events - any order; sorted internally
 * @returns {Promise<{ applied: number, renumbered: Array }>}
 */
export async function replayWithinTx(client, tenantId, events) {
  const ordered = events.slice().sort(compareEvents);
  const { assignments, renumbered } = resolveDisplayNumbers(ordered);

  // Last rekey in canonical order reprefixes every display id (SCP-118).
  let rekeyTo = null;
  for (const e of ordered) if (e.kind === 'workspace.rekey') rekeyTo = e.payload.to;
  if (rekeyTo) {
    for (const a of assignments.values()) {
      a.keyPrefix = rekeyTo;
      a.humanId = `${rekeyTo}-${a.number}`;
    }
  }

  // uid -> human KEY-N id (the value tickets keys on).
  const human = new Map();
  for (const [uid, a] of assignments) human.set(uid, a.humanId);

  const T = tenantId;
  const now = new Date().toISOString();

  // Wipe this tenant's derived rows (workspace row is upserted, not deleted).
  for (const t of ['ticket_history', 'ticket_comments', 'ticket_relations', 'tickets'])
    await client.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [T]);
  // Ensure a workspace row exists; workspace.* events UPDATE it below.
  await client.query(
    `INSERT INTO workspace (tenant_id, key, name, created_at, updated_at)
     VALUES ($1, '', 'Workspace', $2, $2) ON CONFLICT (tenant_id) DO NOTHING`,
    [T, now]
  );

  let wsKey = null;
  let applied = 0;
  for (const e of ordered) {
    applied += await applyEvent(client, T, e, human, assignments);
    if (e.kind === 'workspace.init' || e.kind === 'workspace.set') {
      if (typeof e.payload.key === 'string') wsKey = e.payload.key;
    } else if (e.kind === 'workspace.rekey') {
      wsKey = e.payload.to;
    }
  }

  // Orphan cleanup mirrors the FK CASCADE the SQLite path relies on.
  await client.query(
    `DELETE FROM ticket_comments WHERE tenant_id=$1
       AND ticket_id NOT IN (SELECT id FROM tickets WHERE tenant_id=$1)`, [T]);
  await client.query(
    `DELETE FROM ticket_relations WHERE tenant_id=$1
       AND (from_ticket_id NOT IN (SELECT id FROM tickets WHERE tenant_id=$1)
            OR to_ticket_id NOT IN (SELECT id FROM tickets WHERE tenant_id=$1))`, [T]);
  await client.query(
    `DELETE FROM ticket_history WHERE tenant_id=$1
       AND ticket_id NOT IN (SELECT id FROM tickets WHERE tenant_id=$1)`, [T]);

  // Advance the allocator past every assigned number; follow the rekey/set key.
  await client.query(
    'UPDATE workspace SET next_ticket_number=$2, updated_at=$3 WHERE tenant_id=$1',
    [T, nextNumberSeed(assignments), now]
  );
  if (wsKey) await client.query('UPDATE workspace SET key=$2 WHERE tenant_id=$1', [T, wsKey]);

  return { applied, renumbered };
}

/**
 * Rebuild a tenant's cache from `events` in its own transaction. Acquires a
 * dedicated client from the pool — using the pool directly would let BEGIN and
 * the writes land on different pooled connections, silently breaking atomicity.
 *
 * @param {import('pg').Pool} pool
 * @param {string} tenantId
 * @param {Array<object>} events
 * @returns {Promise<{ applied: number, renumbered: Array }>}
 */
export async function pgReplay(pool, tenantId, events) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await replayWithinTx(client, tenantId, events);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function applyEvent(db, T, e, human, assignments) {
  const p = e.payload;
  switch (e.kind) {
    case 'workspace.init':
    case 'workspace.set': {
      const cols = ['key', 'name', 'description', 'overview'].filter((k) => k in p);
      if (cols.length) {
        const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
        await db.query(`UPDATE workspace SET ${sets} WHERE tenant_id = $1`, [T, ...cols.map((c) => p[c])]);
      }
      return 1;
    }

    case 'ticket.create': {
      const id = human.get(p.ticketId);
      const a = assignments.get(p.ticketId);
      await db.query(
        `INSERT INTO tickets
           (tenant_id, id, uid, number, type, title, description, status, priority,
            parent_id, branch, pr_url, assignee, labels, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
        [
          T, id, p.ticketId, a.number, p.ticketType, p.title, p.description ?? '',
          p.status, p.priority, p.parentId ? human.get(p.parentId) ?? null : null,
          p.branch ?? null, p.prUrl ?? null, p.assignee ?? null,
          JSON.stringify(p.labels ?? []), e.ts,
        ]
      );
      return 1;
    }

    case 'ticket.set_field': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      const column = FIELD_TO_COLUMN[p.field];
      if (!column) return 0;
      let value;
      if (p.field === 'labels') value = JSON.stringify(p.value ?? []);
      else if (p.field === 'parentId') value = p.value ? human.get(p.value) ?? null : null;
      else value = p.value;

      const cur = await db.query(`SELECT ${column} AS v FROM tickets WHERE tenant_id=$1 AND id=$2`, [T, id]);
      if (!cur.rows.length) return 0; // tombstoned — terminal
      const oldValue = cur.rows[0].v;
      await db.query(
        `UPDATE tickets SET ${column}=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2`,
        [T, id, value, e.ts]
      );
      await db.query(
        `INSERT INTO ticket_history (tenant_id, ticket_id, field, old_value, new_value, changed_by, changed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          T, id, column,
          oldValue == null ? null : String(stripJsonb(oldValue)),
          value == null ? null : String(value),
          formatActor(e.actor, e.model), e.ts,
        ]
      );
      return 1;
    }

    case 'ticket.delete': {
      const id = human.get(p.ticketId);
      if (id) await db.query('DELETE FROM tickets WHERE tenant_id=$1 AND id=$2', [T, id]);
      return 1;
    }

    case 'comment.add': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      await db.query(
        `INSERT INTO ticket_comments (tenant_id, ticket_id, author, body, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [T, id, p.author == null ? null : formatActor(p.author, e.model), p.body, e.ts]
      );
      return 1;
    }

    case 'relation.add': {
      const from = human.get(p.fromId);
      const to = human.get(p.toId);
      if (!from || !to) return 0;
      const ins = `INSERT INTO ticket_relations (tenant_id, from_ticket_id, to_ticket_id, type, created_at)
                   VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`;
      await db.query(ins, [T, from, to, p.type, e.ts]);
      await db.query(ins, [T, to, from, RELATION_INVERSE[p.type], e.ts]);
      return 1;
    }

    case 'relation.remove': {
      const from = human.get(p.fromId);
      const to = human.get(p.toId);
      if (!from || !to) return 0;
      const del = `DELETE FROM ticket_relations WHERE tenant_id=$1 AND from_ticket_id=$2 AND to_ticket_id=$3 AND type=$4`;
      await db.query(del, [T, from, to, p.type]);
      await db.query(del, [T, to, from, RELATION_INVERSE[p.type]]);
      return 1;
    }

    default:
      return 0;
  }
}

// labels is the only jsonb column read back as old_value; node-pg returns it as
// a JS value, so stringify it the way SQLite stored it (a JSON string) before
// recording history, keeping changed_by/old_value identical across backends.
function stripJsonb(v) {
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
}
