/**
 * Hosted event store (SCP-142) — the idempotent upload primitive the sync push
 * path (SCP-134) and fan-out (SCP-146) build on.
 *
 * `uploadEvents` unions a batch onto a tenant's canonical log via
 * INSERT ... ON CONFLICT (tenant_id, event_id) DO NOTHING — so re-pushing a
 * known ULID is a no-op and concurrent replica pushes are safe — then re-runs
 * the cache replay (SCP-141) in the SAME transaction, so the log and its
 * projection never diverge. Returns the set of NEWLY-APPLIED events, which is
 * the canonical fan-out source for SCP-146.
 *
 * Tenant isolation is enforced at the row level here (every statement is
 * tenant-scoped); Postgres RLS as defense-in-depth is SCP-144, and verifying
 * the uploaded events' actor against the authenticated principal is SCP-132.
 */
import { validateEvent } from '../event-schema.js';
import { replayWithinTx } from './replay.js';

/**
 * @param {import('pg').Pool} pool
 * @param {string} tenantId
 * @param {Array<object>} events - event envelopes to union onto the log
 * @returns {Promise<{accepted: object[], duplicates: string[], renumbered: Array, cursor: string|null, count: number}>}
 */
export async function uploadEvents(pool, tenantId, events) {
  if (!Array.isArray(events)) throw new Error('events must be an array');
  // Validate the whole batch up front so a bad event lands nothing (atomic).
  for (const e of events) validateEvent(e);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const accepted = [];
    const duplicates = [];
    for (const e of events) {
      const r = await client.query(
        `INSERT INTO events (tenant_id, event_id, ts, kind, body)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, event_id) DO NOTHING`,
        [tenantId, e.id, e.ts, e.kind, e]
      );
      if (r.rowCount === 1) accepted.push(e);
      else duplicates.push(e.id);
    }

    let renumbered = [];
    if (accepted.length) {
      // Re-replay the full tenant log within this same transaction so the cache
      // matches the log atomically (incremental replay is SCP-143).
      const all = (
        await client.query('SELECT body FROM events WHERE tenant_id=$1', [tenantId])
      ).rows.map((row) => row.body);
      ({ renumbered } = await replayWithinTx(client, tenantId, all));
    }

    const agg = await client.query(
      'SELECT max(event_id) AS cursor, count(*)::int AS count FROM events WHERE tenant_id=$1',
      [tenantId]
    );
    await client.query('COMMIT');
    return {
      accepted,
      duplicates,
      renumbered,
      cursor: agg.rows[0].cursor,
      count: agg.rows[0].count,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Pull events after a ULID high-water cursor (SCP-134 semantics, Postgres-
 * backed). Id-sorted pagination keeps the cursor monotonic; the client replays
 * canonically regardless.
 *
 * @returns {Promise<{events: object[], cursor: string|null, count: number, more: boolean}>}
 */
export async function pullEvents(pool, tenantId, { since = null, limit = 1000 } = {}) {
  const cap = Math.min(Number(limit) || 1000, 1000);
  const rows = (
    await pool.query(
      `SELECT body FROM events
       WHERE tenant_id=$1 AND ($2::text IS NULL OR event_id > $2)
       ORDER BY event_id ASC LIMIT $3`,
      [tenantId, since, cap + 1] // fetch one extra to detect `more`
    )
  ).rows.map((r) => r.body);
  const more = rows.length > cap;
  const page = more ? rows.slice(0, cap) : rows;
  const total = (
    await pool.query('SELECT count(*)::int AS c FROM events WHERE tenant_id=$1', [tenantId])
  ).rows[0].c;
  return {
    events: page,
    cursor: page.length ? page[page.length - 1].id : since,
    count: total,
    more,
  };
}

/**
 * Snapshot bootstrap (SCP-137) — a compacted starting point for a fresh client,
 * so it doesn't have to download and replay the entire event log. Returns the
 * already-materialized board (the replay cache) for a tenant plus the tail
 * `cursor`: the client applies `state` directly, then pulls events after
 * `cursor` (pullEvents) to catch the tail.
 *
 * The snapshot is strictly an OPTIMIZATION, never the source of truth — it is by
 * construction exactly what replaying the whole log yields (the cache IS that
 * projection), so it is reproducible by replay (ADR 0002 invariant).
 *
 * @returns {Promise<{cursor: string|null, count: number, state: {workspace, tickets, relations, comments, history}}>}
 */
export async function snapshotState(pool, tenantId) {
  const q = (sql) => pool.query(sql, [tenantId]).then((r) => r.rows);
  const [agg, workspace, tickets, relations, comments, history] = await Promise.all([
    pool.query('SELECT max(event_id) AS cursor, count(*)::int AS count FROM events WHERE tenant_id=$1', [tenantId]),
    q('SELECT key, name, description, overview, next_ticket_number FROM workspace WHERE tenant_id=$1'),
    q('SELECT id, uid, number, type, title, description, status, priority, parent_id, branch, pr_url, assignee, labels, created_at, updated_at FROM tickets WHERE tenant_id=$1 ORDER BY number'),
    q('SELECT from_ticket_id, to_ticket_id, type, created_at FROM ticket_relations WHERE tenant_id=$1'),
    q('SELECT ticket_id, author, body, created_at FROM ticket_comments WHERE tenant_id=$1 ORDER BY id'),
    q('SELECT ticket_id, field, old_value, new_value, changed_by, changed_at FROM ticket_history WHERE tenant_id=$1 ORDER BY id'),
  ]);
  return {
    cursor: agg.rows[0].cursor,
    count: agg.rows[0].count,
    state: { workspace: workspace[0] ?? null, tickets, relations, comments, history },
  };
}
