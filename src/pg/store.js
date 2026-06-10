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
 * tenant-scoped); verifying the uploaded events' actor against the
 * authenticated principal is SCP-132.
 *
 * SCP-189: every public function below additionally runs its statements inside
 * `withTenant` (rls.js), which pins the transaction to the tenant's RLS context
 * (SET LOCAL app.tenant_id, and SET LOCAL ROLE when SCOPE_PG_APP_ROLE is set).
 * The explicit `WHERE tenant_id = $1` clauses are kept as belt-and-suspenders;
 * RLS is the layer beneath them — if a future bug ever drops a WHERE, the
 * database itself refuses cross-tenant rows.
 */
import { validateEvent } from '../event-schema.js';
import { resolveDisplayNumbers } from '../identity.js';
import { replayWithinTx, applyIncrementalWithinTx } from './replay.js';
import { isTailAppend, canonicalMax } from './incremental.js';
import { withTenant } from './rls.js';

/**
 * Of the given event ids, which are already in the tenant's log. Lets the push
 * path actor-check only GENUINELY-NEW events (SCP-230): re-sending events that
 * were already accepted (e.g. a teammate's events pulled into your local log)
 * must not trip actor-authz — they were validated when first uploaded.
 */
export async function existingEventIds(pool, tenantId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return new Set();
  return withTenant(pool, tenantId, async (client) => {
    const rows = (await client.query(
      'SELECT event_id FROM events WHERE tenant_id=$1 AND event_id = ANY($2)', [tenantId, ids]
    )).rows;
    return new Set(rows.map((r) => r.event_id));
  });
}

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

  // SCP-189: withTenant owns BEGIN/COMMIT and pins the RLS tenant context, so
  // the union + replay below stay one atomic, tenant-scoped transaction.
  return withTenant(pool, tenantId, async (client) => {
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
      // SCP-219 incremental fast path. The hot realtime loop pushes a handful of
      // brand-new events that sort AFTER everything already applied; folding just
      // those onto the cache is O(batch) instead of O(whole log). The full
      // replay stays the always-correct fallback.
      //
      // Read the EXISTING log (everything except the just-accepted ids) to decide
      // the tail-append invariant. We need the existing rows anyway for the full
      // replay fallback, so this read isn't extra work on the slow path.
      const acceptedIds = new Set(accepted.map((e) => e.id));
      const all = (
        await client.query('SELECT body FROM events WHERE tenant_id=$1', [tenantId])
      ).rows.map((row) => row.body);
      const existing = all.filter((row) => !acceptedIds.has(row.id));

      // SCP-219: only fast-path onto a POPULATED existing log. From an empty log
      // the full replay is already cheap AND it wipes the tenant's cache rows
      // first, which is the safe behavior if the cache ever sits out of sync with
      // an empty log (incremental assumes the cache already reflects `existing`).
      // Half 1 (ordering): every accepted event must sort strictly after the
      // canonical max of the existing log.
      let fastPath = existing.length > 0 && isTailAppend(canonicalMax(existing), accepted);

      // Half 2 (collision): a new ticket.create whose claimed number duplicates
      // one already assigned to an existing ticket forces SCP-110 renumbering of
      // existing rows — NOT a clean append. Resolve the existing number set once.
      if (fastPath) {
        const existingNumbers = new Set();
        for (const a of resolveDisplayNumbers(existing).assignments.values()) {
          existingNumbers.add(a.number);
        }
        for (const e of accepted) {
          if (e.kind === 'ticket.create' && existingNumbers.has(e.payload.number)) {
            fastPath = false;
            break;
          }
        }
      }

      if (fastPath) {
        ({ renumbered } = await applyIncrementalWithinTx(client, tenantId, all, accepted));
      } else {
        // Fall back to the full tenant-log replay within this same transaction so
        // renumbered ids + their FK/relation rewrites cascade correctly.
        ({ renumbered } = await replayWithinTx(client, tenantId, all));
      }
    }

    const agg = await client.query(
      'SELECT max(seq) AS cursor, count(*)::int AS count FROM events WHERE tenant_id=$1',
      [tenantId]
    );
    return {
      accepted,
      duplicates,
      renumbered,
      cursor: agg.rows[0].cursor != null ? String(agg.rows[0].cursor) : null,
      count: agg.rows[0].count,
    };
  });
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
  // SCP-189: reads run inside the tenant's RLS context too — the database
  // refuses cross-tenant rows even if the WHERE below ever regressed.
  return withTenant(pool, tenantId, async (client) => {
    // Cursor is the server-assigned monotonic seq (SCP-226), NOT the event ULID:
    // an event inserted later always has a higher seq than anything already
    // returned, so a pull never skips a low-ULID event that arrived after the
    // cursor passed it (the multi-writer convergence bug). A legacy/non-numeric
    // cursor (an old ULID) falls back to a full pull, which self-heals it to seq.
    const sinceSeq = since != null && /^\d+$/.test(String(since)) ? String(since) : null;
    const rows = (
      await client.query(
        `SELECT seq, body FROM events
         WHERE tenant_id=$1 AND ($2::bigint IS NULL OR seq > $2::bigint)
         ORDER BY seq ASC LIMIT $3`,
        [tenantId, sinceSeq, cap + 1] // fetch one extra to detect `more`
      )
    ).rows;
    const more = rows.length > cap;
    const page = more ? rows.slice(0, cap) : rows;
    const total = (
      await client.query('SELECT count(*)::int AS c FROM events WHERE tenant_id=$1', [tenantId])
    ).rows[0].c;
    return {
      events: page.map((r) => r.body),
      cursor: page.length ? String(page[page.length - 1].seq) : (sinceSeq ?? since),
      count: total,
      more,
    };
  });
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
  // SCP-189: all six reads share one tenant-scoped transaction (RLS context) —
  // sequential on the txn client (pg deprecates overlapping queries on one
  // client), and as a bonus the snapshot is now a consistent single-txn read.
  return withTenant(pool, tenantId, async (client) => {
    const q = (sql) => client.query(sql, [tenantId]).then((r) => r.rows);
    const agg = await client.query('SELECT max(seq) AS cursor, count(*)::int AS count FROM events WHERE tenant_id=$1', [tenantId]);
    const workspace = await q('SELECT key, name, description, overview, next_ticket_number FROM workspace WHERE tenant_id=$1');
    const tickets = await q('SELECT id, uid, number, type, title, description, status, priority, parent_id, branch, pr_url, assignee, labels, created_at, updated_at FROM tickets WHERE tenant_id=$1 ORDER BY number');
    const relations = await q('SELECT from_ticket_id, to_ticket_id, type, created_at FROM ticket_relations WHERE tenant_id=$1');
    const comments = await q('SELECT ticket_id, author, body, created_at FROM ticket_comments WHERE tenant_id=$1 ORDER BY id');
    const history = await q('SELECT ticket_id, field, old_value, new_value, changed_by, changed_at FROM ticket_history WHERE tenant_id=$1 ORDER BY id');
    return {
      cursor: agg.rows[0].cursor != null ? String(agg.rows[0].cursor) : null,
      count: agg.rows[0].count,
      state: { workspace: workspace[0] ?? null, tickets, relations, comments, history },
    };
  });
}
