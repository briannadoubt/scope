/**
 * Per-tenant replica workspaces (SCP-186) — the bridge that lets the ENTIRE
 * existing REST surface (repo.js handlers over SQLite) serve hosted tenants
 * without rewriting it against Postgres.
 *
 * ADR 0002's invariant is "the cloud node is just another replica": the
 * canonical store for a hosted project is its tenant-scoped Postgres event log
 * (src/pg/store.js), and replay is deterministic. So the hub keeps, for each
 * tenant it serves, a LOCAL replica workspace (.scope dir + SQLite cache) that
 * mirrors that log:
 *
 *   read path:   refresh() — pullEvents(since cursor) → append to the local
 *                log → syncFromLog re-replays → repo.js reads are current.
 *   write path:  the unchanged repo.js mutator emits event files into the
 *                replica's log; flush() uploads every event above the PG
 *                high-water cursor via uploadEvents (idempotent ON CONFLICT
 *                DO NOTHING, replayed into the PG cache in the same tx).
 *
 * Because replay is deterministic and the event set converges (same union on
 * both sides), the replica's SQLite state and the PG cache are the same
 * projection — the replica is disposable and rebuildable at any time.
 *
 * Durability: replicas live under SCOPE_TENANT_DIR (defaults beside SCOPE_DIR
 * on the persistent volume), so a locally-emitted event survives a crash
 * between emit and flush; flush retries on the next touch of that tenant.
 */
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

import { openDb } from '../db.js';
import { appendEvent, readAllEvents, eventsDir } from '../event-store.js';
import { syncFromLog } from '../replay.js';
import { uploadEvents, pullEvents } from '../pg/store.js';

/** Root directory holding one replica workspace per tenant. */
export function tenantReplicaRoot() {
  if (process.env.SCOPE_TENANT_DIR) return process.env.SCOPE_TENANT_DIR;
  // Beside the hub's own SCOPE_DIR (e.g. /data/.scope → /data/.scope-tenants)
  // so replicas land on the same persistent volume.
  if (process.env.SCOPE_DIR) return join(dirname(process.env.SCOPE_DIR), '.scope-tenants');
  return join(homedir(), '.scope-tenants');
}

/** tenantId → { db, scopeDir, cursor, lock } */
const replicas = new Map();

/** Serialize refresh/flush per tenant so overlapping requests can't interleave
 * a half-applied pull with a flush scan. (uploadEvents dedupes regardless —
 * this is about keeping the local log/cache transitions tidy.) */
function withLock(rep, fn) {
  const run = rep.lock.then(fn, fn);
  // Keep the chain alive regardless of individual outcomes.
  rep.lock = run.then(() => {}, () => {});
  return run;
}

/** Highest event ULID in a list (ULIDs sort lexicographically by time). */
function maxId(events) {
  return events.reduce((m, e) => (e.id > m ? e.id : m), '');
}

/**
 * Get (or build) the local replica workspace for a tenant. First touch pulls
 * the full PG log and materializes the SQLite cache; later touches reuse it.
 */
export async function ensureReplica(pool, tenantId) {
  let rep = replicas.get(tenantId);
  if (rep) return rep;

  const scopeDir = join(tenantReplicaRoot(), tenantId, '.scope');
  mkdirSync(join(scopeDir, 'events'), { recursive: true });
  const db = openDb(scopeDir);
  rep = { tenantId, scopeDir, db, cursor: '', lock: Promise.resolve() };
  replicas.set(tenantId, rep);

  await withLock(rep, async () => {
    // Hydrate: union the full PG log onto whatever survived on disk (a warm
    // volume may already hold most of it — appendEvent is id-keyed/idempotent).
    let since = null;
    for (;;) {
      const page = await pullEvents(pool, tenantId, { since });
      for (const e of page.events) appendEvent(eventsDir(scopeDir), e);
      since = page.cursor;
      if (!page.more) break;
    }
    syncFromLog(db, scopeDir);
    // Cursor = PG high-water. Anything on disk above it (a crash between emit
    // and flush) gets pushed by the first flush below.
    rep.cursor = since || '';
    const local = readAllEvents(eventsDir(scopeDir));
    const unflushed = local.filter((e) => e.id > rep.cursor);
    if (unflushed.length) {
      const r = await uploadEvents(pool, tenantId, unflushed);
      rep.cursor = r.cursor || rep.cursor;
    }
  });
  return rep;
}

/** Pull events newer than our cursor into the local log; replay if any. */
export function refreshReplica(pool, rep) {
  return withLock(rep, async () => {
    let appended = 0;
    for (;;) {
      const page = await pullEvents(pool, rep.tenantId, { since: rep.cursor || null });
      for (const e of page.events) { appendEvent(eventsDir(rep.scopeDir), e); appended++; }
      if (page.cursor) rep.cursor = page.cursor;
      if (!page.more) break;
    }
    if (appended) syncFromLog(rep.db, rep.scopeDir);
  });
}

/** Push every locally-emitted event above the PG cursor up to the canonical log. */
export function flushReplica(pool, rep) {
  return withLock(rep, async () => {
    const local = readAllEvents(eventsDir(rep.scopeDir));
    const pending = local.filter((e) => e.id > rep.cursor);
    if (!pending.length) return { pushed: 0 };
    const r = await uploadEvents(pool, rep.tenantId, pending);
    rep.cursor = r.cursor || rep.cursor;
    return { pushed: r.accepted.length };
  });
}

/** Drop a tenant's in-memory replica (tests / project deletion). */
export function evictReplica(tenantId, { removeFiles = false } = {}) {
  const rep = replicas.get(tenantId);
  if (!rep) return;
  try { rep.db.close(); } catch {}
  replicas.delete(tenantId);
  if (removeFiles) {
    try { rmSync(dirname(rep.scopeDir), { recursive: true, force: true }); } catch {}
  }
}

/** Close every replica (server shutdown). */
export function closeAllReplicas() {
  for (const id of [...replicas.keys()]) evictReplica(id);
}

export const _internals = { replicas, maxId };
