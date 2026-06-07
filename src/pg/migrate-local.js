/**
 * Migrate a local `.scope/events` log into a hosted tenant (SCP-145).
 *
 * The local-first CLI's source of truth is the append-only event log on disk
 * (`.scope/events/<ulid>.json`). Migrating to hosted Scope is therefore "just
 * another replica push": read every local event and union it onto the tenant's
 * canonical Postgres log via the SAME idempotent upload primitive the sync push
 * path uses (store.js `uploadEvents`). There is NO special-case import path —
 * bulk union with ON CONFLICT DO NOTHING is the whole story.
 *
 * Because upload is a pure union keyed on the ULID event id:
 *  - Re-running the migration is a no-op (every event is already present →
 *    all duplicates). Safe to retry after a partial failure or to "top up" a
 *    tenant after the user appended more local events.
 *  - The hosted cache (board) is rebuilt by the SAME deterministic replay a
 *    local replica runs, so a migrated tenant's board is byte-identical to the
 *    user's local board for the same event set (the golden-test invariant).
 */
import { readAllEvents, eventsDir } from '../event-store.js';

/**
 * Read the local log under `scopeDir` and union it onto `tenantId`'s hosted log.
 * Idempotent: safe to run repeatedly; only never-seen events are applied.
 *
 * @param {import('pg').Pool} pool
 * @param {string} tenantId - the destination tenant (a project IS a tenant)
 * @param {string} scopeDir - the local `.scope` directory to import from
 * @param {object} [opts]
 * @param {(events: object[]) => Promise<any>} [opts.upload] - injectable upload
 *        for testing; defaults to store.js `uploadEvents(pool, tenantId, ...)`.
 * @returns {Promise<{
 *   read: number,        // events found in the local log
 *   applied: number,     // newly-unioned (accepted) events
 *   duplicates: number,  // events already present on the hosted log
 *   cursor: string|null, // hosted high-water ULID after migration
 *   count: number,       // total events on the hosted log after migration
 * }>}
 */
export async function migrateLocalLog(pool, tenantId, scopeDir, opts = {}) {
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new Error('migrateLocalLog requires a non-empty tenantId');
  }
  // Strict read (not tolerant): a corrupt local event aborts the migration
  // rather than silently dropping data from the user's history.
  const events = readAllEvents(eventsDir(scopeDir));

  if (events.length === 0) {
    return { read: 0, applied: 0, duplicates: 0, cursor: null, count: 0 };
  }

  // Lazy import keeps this module loadable without a live pool (mirrors the
  // hosted-only loading discipline in pool.js) and lets tests inject `upload`.
  const upload =
    opts.upload ||
    (async (evts) => {
      const { uploadEvents } = await import('./store.js');
      return uploadEvents(pool, tenantId, evts);
    });

  const r = await upload(events);
  return {
    read: events.length,
    applied: r.accepted.length,
    duplicates: r.duplicates.length,
    cursor: r.cursor,
    count: r.count,
  };
}
