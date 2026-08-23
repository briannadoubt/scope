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
import { withTenant, TENANT_GUC } from './rls.js';
import { createHash } from 'node:crypto';
import { committedEvents } from '../event-store.js';

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
  // SCP-189: pin the caller's open transaction to this tenant's RLS context
  // (SET LOCAL semantics — dies with the txn). Idempotent when the caller
  // already set it via withTenant; for direct callers it guarantees every
  // statement below runs under the tenant's row-level-security policies.
  await client.query('SELECT set_config($1, $2, true)', [TENANT_GUC, tenantId]);

  const ordered = committedEvents(events).slice().sort(compareEvents);
  const { assignments, renumbered, human } = resolveProjection(ordered);

  const T = tenantId;
  const now = new Date().toISOString();

  // Wipe this tenant's derived rows (workspace row is upserted, not deleted).
  for (const t of ['agent_messages','agent_registry','agent_conflicts','agent_plans','agent_discoveries','agent_attempts','agent_leases','agent_contracts','ticket_artifacts', 'ticket_history', 'ticket_comments', 'ticket_relations', 'tickets'])
    await client.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [T]);
  await ensureWorkspaceRow(client, T, now);

  const { applied, wsKey } = await applyEventLoop(client, T, ordered, human, assignments);
  await materializeConflicts(client, T, ordered, human);

  await cleanupOrphans(client, T);
  await advanceWorkspace(client, T, now, nextNumberSeed(assignments), wsKey);

  return { applied, renumbered };
}

/**
 * Incremental replay (SCP-219), the PG twin of replay.js applyEvents. Folds ONLY
 * `newEvents` onto the tenant's existing cache within the caller's open
 * transaction, instead of wiping + re-replaying the whole log. The caller
 * (store.js uploadEvents) has ALREADY decided this batch is a clean tail-append
 * (ordering half via isTailAppend + the create-number-collision half against the
 * existing number set), so this routine just applies the fold.
 *
 * `allEvents` is the full post-batch log; the projection is resolved over it so
 * existing tickets referenced by new events map to their already-cached
 * humanIds (unchanged by a clean tail-append), but only the new events are
 * WRITTEN. The full `replayWithinTx` remains the always-correct fallback.
 *
 * @param {import('pg').PoolClient} client - client with an open transaction
 * @param {string} tenantId
 * @param {Array<object>} allEvents - full log after the batch (any order)
 * @param {Array<object>} newEvents - freshly-accepted events (any order)
 * @returns {Promise<{ applied: number, renumbered: Array }>}
 */
export async function applyIncrementalWithinTx(client, tenantId, allEvents, newEvents) {
  await client.query('SELECT set_config($1, $2, true)', [TENANT_GUC, tenantId]);

  const T = tenantId;
  const now = new Date().toISOString();

  // Projection over the FULL set (pure); the renumbered list it yields is what a
  // full replay would report, keeping the return contract identical.
  const orderedAll = allEvents.slice().sort(compareEvents);
  const { assignments, renumbered, human } = resolveProjection(orderedAll);
  const orderedNew = newEvents.slice().sort(compareEvents);

  // The workspace row already exists for any tenant with prior events, but a
  // first-ever push (empty existing log) is also a valid tail-append, so ensure.
  await ensureWorkspaceRow(client, T, now);

  const { applied, wsKey } = await applyEventLoop(client, T, orderedNew, human, assignments);

  await cleanupOrphans(client, T);
  await advanceWorkspace(client, T, now, nextNumberSeed(assignments), wsKey);

  return { applied, renumbered };
}

/**
 * Pure projection (SCP-219): canonical display numbers + uid->humanId map with
 * the SCP-118 rekey override. Shared by the full and incremental PG replays so
 * both compute the identical projection.
 */
function resolveProjection(ordered) {
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

  return { assignments, renumbered, human };
}

/** Ensure a tenant workspace row exists; workspace.* events UPDATE it. */
async function ensureWorkspaceRow(client, T, now) {
  await client.query(
    `INSERT INTO workspace (tenant_id, key, name, created_at, updated_at)
     VALUES ($1, '', 'Workspace', $2, $2) ON CONFLICT (tenant_id) DO NOTHING`,
    [T, now]
  );
}

/**
 * Apply `ordered` events for a tenant. Shared loop body for the full and
 * incremental PG replays. Returns { applied, wsKey } (last workspace key seen).
 */
async function applyEventLoop(client, T, ordered, human, assignments) {
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
  return { applied, wsKey };
}

/** Orphan cleanup mirroring the SQLite FK CASCADE for a tenant. */
async function cleanupOrphans(client, T) {
  for (const table of ['agent_contracts','agent_leases','agent_attempts','agent_discoveries','agent_plans','agent_conflicts']) {
    await client.query(`DELETE FROM ${table} WHERE tenant_id=$1
      AND ticket_id NOT IN (SELECT id FROM tickets WHERE tenant_id=$1)`, [T]);
  }
  await client.query(
    `DELETE FROM ticket_artifacts WHERE tenant_id=$1
       AND ticket_id NOT IN (SELECT id FROM tickets WHERE tenant_id=$1)`, [T]);
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
  await client.query(
    `UPDATE agent_messages SET ticket_id=NULL WHERE tenant_id=$1 AND ticket_id IS NOT NULL
       AND ticket_id NOT IN (SELECT id FROM tickets WHERE tenant_id=$1)`, [T]);
}

/** Advance the allocator past every assigned number; follow the rekey/set key. */
async function advanceWorkspace(client, T, now, seed, wsKey) {
  await client.query(
    'UPDATE workspace SET next_ticket_number=$2, updated_at=$3 WHERE tenant_id=$1',
    [T, seed, now]
  );
  if (wsKey) await client.query('UPDATE workspace SET key=$2 WHERE tenant_id=$1', [T, wsKey]);
}

/**
 * Rebuild a tenant's cache from `events` in its own transaction. Runs through
 * withTenant (SCP-189), which owns a dedicated client + BEGIN/COMMIT — using
 * the pool directly would let BEGIN and the writes land on different pooled
 * connections, silently breaking atomicity — and pins the tenant RLS context.
 *
 * @param {import('pg').Pool} pool
 * @param {string} tenantId
 * @param {Array<object>} events
 * @returns {Promise<{ applied: number, renumbered: Array }>}
 */
export async function pgReplay(pool, tenantId, events) {
  return withTenant(pool, tenantId, (client) => replayWithinTx(client, tenantId, events));
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
      // SCP-243: `rank` is cosmetic ordering — apply it but keep it out of the
      // audit history (matching updateTicket + the SQLite replay path).
      if (p.field !== 'rank') {
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
      }
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

    case 'artifact.put': {
      const id = human.get(p.ticketId);
      if (!id) return 0;
      await db.query(
        `INSERT INTO ticket_artifacts
           (tenant_id, id, ticket_id, name, mime_type, content, size_bytes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           ticket_id=excluded.ticket_id, name=excluded.name,
           mime_type=excluded.mime_type, content=excluded.content,
           size_bytes=excluded.size_bytes, updated_at=excluded.updated_at`,
        [T, p.artifactId, id, p.name, p.mimeType, p.content,
          new TextEncoder().encode(p.content).length, e.ts]
      );
      return 1;
    }

    case 'artifact.remove':
      await db.query('DELETE FROM ticket_artifacts WHERE tenant_id=$1 AND id=$2', [T, p.artifactId]);
      return 1;

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

    case 'agent.contract.set': {
      const id = human.get(p.ticketId); if (!id) return 0; const c = p.contract;
      await db.query(`INSERT INTO agent_contracts
        (tenant_id,ticket_id,acceptance,constraints,verification_commands,required_capabilities,policy,plan_version,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8) ON CONFLICT (tenant_id,ticket_id) DO UPDATE SET
        acceptance=excluded.acceptance,constraints=excluded.constraints,verification_commands=excluded.verification_commands,
        required_capabilities=excluded.required_capabilities,policy=excluded.policy,updated_at=excluded.updated_at`,
        [T,id,JSON.stringify(c.acceptance??[]),JSON.stringify(c.constraints??[]),
          JSON.stringify(c.verificationCommands??[]),JSON.stringify(c.requiredCapabilities??[]),
          JSON.stringify(c.policy??{}),e.ts]);
      return 1;
    }
    case 'agent.lease.claim': {
      const id = human.get(p.ticketId); if (!id) return 0;
      await db.query(`INSERT INTO agent_leases
        (tenant_id,lease_id,ticket_id,agent,capabilities,worktree,branch,base_sha,files,claimed_at,heartbeat_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)
        ON CONFLICT (tenant_id,lease_id) DO UPDATE SET expires_at=excluded.expires_at`,
        [T,p.leaseId,id,p.agent,JSON.stringify(p.capabilities??[]),p.worktree??null,p.branch??null,
          p.baseSha??null,JSON.stringify(p.files??[]),p.claimedAt??e.ts,p.expiresAt]);
      return 1;
    }
    case 'agent.lease.renew':
      await db.query(`UPDATE agent_leases SET heartbeat_at=$3,expires_at=$4,
        files=COALESCE($5::jsonb,files),worktree=COALESCE($6,worktree),
        branch=COALESCE($7,branch),base_sha=COALESCE($8,base_sha)
        WHERE tenant_id=$1 AND lease_id=$2`,
        [T,p.leaseId,p.heartbeatAt??e.ts,p.expiresAt,p.files ? JSON.stringify(p.files) : null,
          p.worktree??null,p.branch??null,p.baseSha??null]); return 1;
    case 'agent.lease.release':
      await db.query('UPDATE agent_leases SET released_at=$3,release_reason=$4 WHERE tenant_id=$1 AND lease_id=$2',[T,p.leaseId,p.releasedAt??e.ts,p.reason??'released']); return 1;
    case 'agent.attempt.start': {
      const id = human.get(p.ticketId); if (!id) return 0;
      await db.query(`INSERT INTO agent_attempts (tenant_id,attempt_id,ticket_id,lease_id,agent,status,started_at)
        VALUES ($1,$2,$3,$4,$5,'running',$6) ON CONFLICT (tenant_id,attempt_id) DO NOTHING`,
        [T,p.attemptId,id,p.leaseId??null,p.agent,p.startedAt??e.ts]); return 1;
    }
    case 'agent.attempt.finish':
      await db.query(`UPDATE agent_attempts SET status=$3,finished_at=$4,summary=$5,failure=$6,evidence=$7,verification=$8
        WHERE tenant_id=$1 AND attempt_id=$2`,[T,p.attemptId,p.outcome,p.finishedAt??e.ts,p.summary??null,p.failure??null,
          JSON.stringify(p.evidence??[]),JSON.stringify(p.verification??[])]); return 1;
    case 'agent.discovery.add': {
      const id = human.get(p.ticketId); if (!id) return 0;
      await db.query(`INSERT INTO agent_discoveries (tenant_id,discovery_id,ticket_id,type,body,data,author,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,discovery_id) DO NOTHING`,
        [T,p.discoveryId,id,p.discoveryType,p.body,JSON.stringify(p.data??{}),p.author??null,p.createdAt??e.ts]); return 1;
    }
    case 'agent.plan.revise': {
      const id = human.get(p.ticketId); if (!id) return 0;
      await db.query(`INSERT INTO agent_plans (tenant_id,ticket_id,version,body,reason,actor,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,ticket_id,version) DO NOTHING`,
        [T,id,p.version,p.body,p.reason??null,e.actor,p.createdAt??e.ts]);
      await db.query(`INSERT INTO agent_contracts (tenant_id,ticket_id,updated_at,plan_version)
        VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,ticket_id) DO UPDATE SET plan_version=excluded.plan_version,updated_at=excluded.updated_at`,
        [T,id,p.createdAt??e.ts,p.version]); return 1;
    }
    case 'agent.conflict.resolve': return 1;
    case 'agent.register':
      await db.query(`INSERT INTO agent_registry
        (tenant_id,agent_id,display_name,provider,capabilities,metadata,status,registered_at,last_seen_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id,agent_id) DO UPDATE SET
        display_name=excluded.display_name,provider=excluded.provider,capabilities=excluded.capabilities,
        metadata=excluded.metadata,status=excluded.status,last_seen_at=excluded.last_seen_at,expires_at=excluded.expires_at`,
        [T,p.agentId,p.displayName,p.provider??null,JSON.stringify(p.capabilities??[]),JSON.stringify(p.metadata??{}),
          p.status,p.registeredAt,p.seenAt,p.expiresAt]);
      return 1;
    case 'agent.heartbeat':
      await db.query(`UPDATE agent_registry SET status=$3,capabilities=$4,metadata=$5,last_seen_at=$6,expires_at=$7
        WHERE tenant_id=$1 AND agent_id=$2`,
        [T,p.agentId,p.status,JSON.stringify(p.capabilities??[]),JSON.stringify(p.metadata??{}),p.seenAt,p.expiresAt]);
      return 1;
    case 'agent.message.send': {
      const ticketId = p.ticketId ? human.get(p.ticketId) ?? null : null;
      await db.query(`INSERT INTO agent_messages
        (tenant_id,message_id,ticket_id,from_agent,to_agent,kind,body,artifact_refs,thread_id,reply_to,correlation_id,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (tenant_id,message_id) DO NOTHING`,
        [T,p.messageId,ticketId,p.fromAgent,p.toAgent,p.kind,p.body,JSON.stringify(p.artifactRefs??[]),
          p.threadId,p.replyTo??null,p.correlationId??null,p.createdAt,p.expiresAt??null]);
      return 1;
    }
    case 'agent.message.ack':
      await db.query(`UPDATE agent_messages SET acked_at=$3,acked_by=$4
        WHERE tenant_id=$1 AND message_id=$2 AND acked_at IS NULL`,
        [T,p.messageId,p.acknowledgedAt,p.agent]);
      return 1;

    default:
      return 0;
  }
}

async function materializeConflicts(db, T, ordered, human) {
  const groups = new Map(); const resolutions = [];
  for (const event of ordered) {
    if (event.kind === 'agent.conflict.resolve') { resolutions.push(event); continue; }
    if (event.kind !== 'ticket.set_field' || !event.baseRevision) continue;
    const key = `${event.baseRevision}\n${event.payload.ticketId}\n${event.payload.field}`;
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(event);
  }
  for (const [key, events] of groups) {
    if (events.length < 2 || new Set(events.map((x)=>JSON.stringify(x.payload.value))).size < 2 || new Set(events.map((x)=>x.actor)).size < 2) continue;
    const [baseRevision,uid,field]=key.split('\n'); const ticketId=human.get(uid); if(!ticketId) continue;
    const conflictId=createHash('sha256').update(key).digest('hex');
    await db.query(`INSERT INTO agent_conflicts
      (tenant_id,conflict_id,ticket_id,field,base_revision,event_ids,values_json,detected_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id,conflict_id) DO NOTHING`,
      [T,conflictId,ticketId,field,baseRevision,JSON.stringify(events.map((x)=>x.id)),
        JSON.stringify(events.map((x)=>({eventId:x.id,actor:x.actor,value:x.payload.value}))),events.map((x)=>x.ts).sort()[0]]);
  }
  for (const event of resolutions) await db.query(`UPDATE agent_conflicts SET resolved_at=$3,resolution=$4
    WHERE tenant_id=$1 AND conflict_id=$2`,[T,event.payload.conflictId,event.payload.resolvedAt??event.ts,
      JSON.stringify(event.payload.resolution??null)]);
}

// labels is the only jsonb column read back as old_value; node-pg returns it as
// a JS value, so stringify it the way SQLite stored it (a JSON string) before
// recording history, keeping changed_by/old_value identical across backends.
function stripJsonb(v) {
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : v;
}
