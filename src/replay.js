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
import { createHash } from 'node:crypto';

import { nowIso, openDb, defaultScopeDir, findScopeDir, getMeta, setMeta } from './db.js';
import { compareEvents, formatActor } from './event-schema.js';
import { resolveDisplayNumbers, nextNumberSeed } from './identity.js';
import { committedEvents, readAllEvents, eventsDir, logHasInit } from './event-store.js';
import { COLUMN_TO_FIELD, RELATION_INVERSE } from './enums.js';
import { normalizeColumns } from './columns.js';
// SCP-219: tail-append decision helpers shared with the PG fast path.
import { isTailAppend, canonicalMax } from './pg/incremental.js';

/** Count event files in a .scope dir (cheap staleness signal; log is append-only). */
export function countEventFiles(scopeDir) {
  const dir = eventsDir(scopeDir);
  if (!existsSync(dir)) return 0;
  return readAllEvents(dir).length;
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
  const ordered = committedEvents(events).slice().sort(compareEvents);
  const { assignments, renumbered, human } = resolveProjection(ordered);

  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    // Clear derived state. The workspace row (singleton) is updated in place.
    db.exec(`
      DELETE FROM agent_messages;
      DELETE FROM agent_registry;
      DELETE FROM agent_plans;
      DELETE FROM agent_discoveries;
      DELETE FROM agent_attempts;
      DELETE FROM agent_leases;
      DELETE FROM agent_contracts;
      DELETE FROM agent_conflicts;
      DELETE FROM ticket_history;
      DELETE FROM ticket_comments;
      DELETE FROM ticket_relations;
      DELETE FROM ticket_artifacts;
      DELETE FROM tickets;
    `);

    const { applied, wsKey } = applyEventLoop(db, ordered, human, assignments);
    materializeConflicts(db, ordered, human);

    // Orphan cleanup mirrors the FK CASCADE the live path relies on: a delete
    // event removes the ticket, so its comments/relations must go too even if
    // their events were applied earlier.
    db.exec(`
      DELETE FROM ticket_comments WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM ticket_relations
        WHERE from_ticket_id NOT IN (SELECT id FROM tickets)
           OR to_ticket_id   NOT IN (SELECT id FROM tickets);
      DELETE FROM ticket_history WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM ticket_artifacts WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_contracts WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_leases WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_attempts WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_discoveries WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_plans WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_conflicts WHERE ticket_id NOT IN (SELECT id FROM tickets);
      UPDATE agent_messages SET ticket_id=NULL
        WHERE ticket_id IS NOT NULL AND ticket_id NOT IN (SELECT id FROM tickets);
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

  // A sibling write from the same causal base must be compared with its peer
  // and materialized as a visible conflict, which requires the full log view.
  if (fastPath) {
    const siblingKeys = new Set(existing
      .filter((event) => event.kind === 'ticket.set_field' && event.baseRevision)
      .map((event) => `${event.baseRevision}\n${event.payload.ticketId}\n${event.payload.field}`));
    if (newEvents.some((event) => event.kind === 'ticket.set_field' && event.baseRevision
      && siblingKeys.has(`${event.baseRevision}\n${event.payload.ticketId}\n${event.payload.field}`))) fastPath = false;
  }

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
      DELETE FROM ticket_artifacts WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_contracts WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_leases WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_attempts WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_discoveries WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_plans WHERE ticket_id NOT IN (SELECT id FROM tickets);
      DELETE FROM agent_conflicts WHERE ticket_id NOT IN (SELECT id FROM tickets);
      UPDATE agent_messages SET ticket_id=NULL
        WHERE ticket_id IS NOT NULL AND ticket_id NOT IN (SELECT id FROM tickets);
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

    case 'artifact.put': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      db.prepare(
        `INSERT INTO ticket_artifacts
           (id, ticket_id, name, mime_type, content, size_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ticket_id=excluded.ticket_id, name=excluded.name,
           mime_type=excluded.mime_type, content=excluded.content,
           size_bytes=excluded.size_bytes, updated_at=excluded.updated_at`
      ).run(
        p.artifactId, id, p.name, p.mimeType, p.content,
        new TextEncoder().encode(p.content).length, e.ts, e.ts
      );
      return 1;
    }

    case 'artifact.remove':
      db.prepare('DELETE FROM ticket_artifacts WHERE id = ?').run(p.artifactId);
      return 1;

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

    case 'agent.contract.set': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      const c = p.contract;
      db.prepare(`INSERT INTO agent_contracts
        (ticket_id,acceptance,constraints,verification_commands,required_capabilities,policy,plan_version,updated_at)
        VALUES (?,?,?,?,?,?,0,?) ON CONFLICT(ticket_id) DO UPDATE SET
          acceptance=excluded.acceptance,constraints=excluded.constraints,
          verification_commands=excluded.verification_commands,required_capabilities=excluded.required_capabilities,
          policy=excluded.policy,updated_at=excluded.updated_at`).run(
        id, JSON.stringify(c.acceptance ?? []), JSON.stringify(c.constraints ?? []),
        JSON.stringify(c.verificationCommands ?? []), JSON.stringify(c.requiredCapabilities ?? []),
        JSON.stringify(c.policy ?? {}), e.ts
      );
      return 1;
    }
    case 'agent.lease.claim': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      db.prepare(`INSERT OR REPLACE INTO agent_leases
        (lease_id,ticket_id,agent,capabilities,worktree,branch,base_sha,files,claimed_at,heartbeat_at,expires_at,released_at,release_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(
        p.leaseId,id,p.agent,JSON.stringify(p.capabilities ?? []),p.worktree ?? null,p.branch ?? null,
        p.baseSha ?? null,JSON.stringify(p.files ?? []),p.claimedAt ?? e.ts,p.claimedAt ?? e.ts,p.expiresAt
      );
      return 1;
    }
    case 'agent.lease.renew':
      db.prepare(`UPDATE agent_leases SET heartbeat_at=?,expires_at=?,files=COALESCE(?,files),
        worktree=COALESCE(?,worktree),branch=COALESCE(?,branch),base_sha=COALESCE(?,base_sha) WHERE lease_id=?`)
        .run(p.heartbeatAt ?? e.ts,p.expiresAt,p.files ? JSON.stringify(p.files) : null,
          p.worktree ?? null,p.branch ?? null,p.baseSha ?? null,p.leaseId);
      return 1;
    case 'agent.lease.release':
      db.prepare('UPDATE agent_leases SET released_at=?,release_reason=? WHERE lease_id=?')
        .run(p.releasedAt ?? e.ts,p.reason ?? 'released',p.leaseId);
      return 1;
    case 'agent.resources.set':
      db.prepare('UPDATE agent_leases SET resources=? WHERE lease_id=?')
        .run(JSON.stringify(p.resources), p.leaseId);
      return 1;
    case 'agent.attempt.start': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      db.prepare(`INSERT OR REPLACE INTO agent_attempts
        (attempt_id,ticket_id,lease_id,agent,status,started_at,evidence,verification)
        VALUES (?,?,?,?,?,?,?,?)`).run(p.attemptId,id,p.leaseId ?? null,p.agent,'running',p.startedAt ?? e.ts,'[]','[]');
      return 1;
    }
    case 'agent.attempt.finish':
      db.prepare(`UPDATE agent_attempts SET status=?,finished_at=?,summary=?,failure=?,evidence=?,verification=? WHERE attempt_id=?`)
        .run(p.outcome,p.finishedAt ?? e.ts,p.summary ?? null,p.failure ?? null,
          JSON.stringify(p.evidence ?? []),JSON.stringify(p.verification ?? []),p.attemptId);
      return 1;
    case 'agent.discovery.add': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      db.prepare(`INSERT OR REPLACE INTO agent_discoveries
        (discovery_id,ticket_id,type,body,data,author,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(p.discoveryId,id,p.discoveryType,p.body,JSON.stringify(p.data ?? {}),p.author ?? null,p.createdAt ?? e.ts);
      return 1;
    }
    case 'agent.plan.revise': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      db.prepare(`INSERT OR REPLACE INTO agent_plans
        (ticket_id,version,body,reason,actor,created_at) VALUES (?,?,?,?,?,?)`)
        .run(id,p.version,p.body,p.reason ?? null,e.actor,p.createdAt ?? e.ts);
      db.prepare(`INSERT INTO agent_contracts (ticket_id,updated_at,plan_version) VALUES (?,?,?)
        ON CONFLICT(ticket_id) DO UPDATE SET plan_version=excluded.plan_version,updated_at=excluded.updated_at`)
        .run(id,p.createdAt ?? e.ts,p.version);
      return 1;
    }
    case 'agent.conflict.resolve':
      return 1; // Applied after sibling detection by materializeConflicts().
    case 'agent.register':
      db.prepare(`INSERT INTO agent_registry
        (agent_id,display_name,provider,capabilities,metadata,status,registered_at,last_seen_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET
          display_name=excluded.display_name,provider=excluded.provider,
          capabilities=excluded.capabilities,metadata=excluded.metadata,status=excluded.status,
          last_seen_at=excluded.last_seen_at,expires_at=excluded.expires_at`).run(
        p.agentId,p.displayName,p.provider??null,JSON.stringify(p.capabilities??[]),JSON.stringify(p.metadata??{}),
        p.status,p.registeredAt,p.seenAt,p.expiresAt
      );
      return 1;
    case 'agent.heartbeat':
      db.prepare(`UPDATE agent_registry SET status=?,capabilities=?,metadata=?,last_seen_at=?,expires_at=?
        WHERE agent_id=?`).run(
        p.status,JSON.stringify(p.capabilities??[]),JSON.stringify(p.metadata??{}),p.seenAt,p.expiresAt,p.agentId
      );
      return 1;
    case 'agent.message.send': {
      const ticketId = p.ticketId ? human.get(p.ticketId) ?? null : null;
      db.prepare(`INSERT OR IGNORE INTO agent_messages
        (message_id,ticket_id,from_agent,to_agent,kind,body,artifact_refs,thread_id,reply_to,correlation_id,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        p.messageId,ticketId,p.fromAgent,p.toAgent,p.kind,p.body,JSON.stringify(p.artifactRefs??[]),
        p.threadId,p.replyTo??null,p.correlationId??null,p.createdAt,p.expiresAt??null
      );
      return 1;
    }
    case 'agent.message.ack':
      db.prepare('UPDATE agent_messages SET acked_at=?,acked_by=? WHERE message_id=? AND acked_at IS NULL')
        .run(p.acknowledgedAt,p.agent,p.messageId);
      return 1;

    default:
      return 0;
  }
}

function materializeConflicts(db, ordered, human) {
  const groups = new Map();
  const resolutions = [];
  for (const event of ordered) {
    if (event.kind === 'agent.conflict.resolve') { resolutions.push(event); continue; }
    if (event.kind !== 'ticket.set_field' || !event.baseRevision) continue;
    const key = `${event.baseRevision}\n${event.payload.ticketId}\n${event.payload.field}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  for (const [key, events] of groups) {
    const values = new Set(events.map((event) => JSON.stringify(event.payload.value)));
    const actors = new Set(events.map((event) => event.actor));
    if (events.length < 2 || values.size < 2 || actors.size < 2) continue;
    const [baseRevision, uid, field] = key.split('\n');
    const ticketId = human.get(uid);
    if (!ticketId) continue;
    const conflictId = createHash('sha256').update(key).digest('hex');
    db.prepare(`INSERT OR REPLACE INTO agent_conflicts
      (conflict_id,ticket_id,field,base_revision,event_ids,values_json,detected_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      conflictId,ticketId,field,baseRevision,JSON.stringify(events.map((event) => event.id)),
      JSON.stringify(events.map((event) => ({ eventId: event.id, actor: event.actor, value: event.payload.value }))),
      events.map((event) => event.ts).sort()[0]
    );
  }
  for (const event of resolutions) {
    db.prepare('UPDATE agent_conflicts SET resolved_at=?,resolution=? WHERE conflict_id=?')
      .run(event.payload.resolvedAt ?? event.ts,JSON.stringify(event.payload.resolution ?? null),event.payload.conflictId);
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
