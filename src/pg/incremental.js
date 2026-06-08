/**
 * Incremental replay on append, with safe fallback (SCP-143).
 *
 * Today every upload (store.js `uploadEvents`) re-replays the tenant's ENTIRE
 * log within the upload transaction. That is always correct but O(log size) per
 * push — wasteful for the overwhelmingly common case where a replica pushes a
 * few brand-new events that sort AFTER everything already applied.
 *
 * This module provides the PURE decision helper that gates a fast path, plus the
 * documented invariant. The actual fast-path wiring in store.js is an
 * INTEGRATION INSTRUCTION (this module does not edit store.js).
 *
 * ── The tail-append invariant ───────────────────────────────────────────────
 * Replay is deterministic in canonical order: events sort by (ts, id) — see
 * `compareEvents` — and `resolveDisplayNumbers` assigns display numbers in that
 * order. A new batch can be applied INCREMENTALLY (just fold its events onto the
 * existing cache, in canonical order) WITHOUT redoing prior work iff applying it
 * cannot change how any ALREADY-APPLIED event was projected. That holds exactly
 * when the batch is a pure *tail append*:
 *
 *   every new event sorts strictly after the max already-applied event in
 *   canonical (ts, id) order
 *       AND
 *   the batch introduces no ticket-number collision against the existing log
 *   (no `ticket.create` whose claimed number duplicates one already assigned —
 *   that would force a renumber of existing rows, i.e. NOT a clean append).
 *
 * If either condition fails (an event lands in the middle of history, or a
 * create collides and triggers SCP-110 renumbering), we MUST fall back to a full
 * tenant-scoped replay so renumbered ids and their FK/relation rewrites cascade
 * correctly through the cache. The fast path is an optimization; the full replay
 * is the always-correct ground truth, and a golden test pins them equal.
 *
 * `isTailAppend` only decides the (ts,id) ordering half — the cheap, pure check.
 * The create-collision half needs the existing number set, so it is evaluated in
 * store.js where that set is already in hand (see INTEGRATION INSTRUCTIONS).
 */
import { compareEvents } from '../event-schema.js';

/**
 * Is `batch` a pure tail-append relative to the already-applied max?
 *
 * Pure (no I/O, no mutation): given the canonical max of what's already applied
 * (`existingMax`, an {ts,id} or null when the log is empty) and the incoming
 * `batch`, return true iff EVERY batch event sorts strictly after `existingMax`.
 *
 * - Empty batch → true (nothing to apply; trivially a no-op tail).
 * - Empty existing log (`existingMax == null`) → true (everything is "after"
 *   nothing; the first push is itself a clean append from empty).
 * - A batch event equal to or before `existingMax` → false (it lands inside or
 *   at history; prior projections could change → full replay).
 *
 * Note this is the ORDERING half of the invariant only. The caller must ALSO
 * confirm no create-number collision before taking the fast path (see module
 * docs / INTEGRATION INSTRUCTIONS).
 *
 * @param {{ts: string, id: string}|null} existingMax - canonical max already
 *        applied, or null if the tenant's log is empty.
 * @param {Array<{ts: string, id: string}>} batch - incoming events (any order).
 * @returns {boolean}
 */
export function isTailAppend(existingMax, batch) {
  if (!Array.isArray(batch) || batch.length === 0) return true;
  if (existingMax == null) return true;
  for (const e of batch) {
    // e must sort strictly AFTER existingMax: compareEvents(existingMax, e) < 0.
    if (compareEvents(existingMax, e) >= 0) return false;
  }
  return true;
}

/**
 * Convenience: the canonical max of a set of events, or null if empty. Useful in
 * store.js to derive `existingMax` from the rows already on the log.
 *
 * @param {Array<{ts: string, id: string}>} events
 * @returns {{ts: string, id: string}|null}
 */
export function canonicalMax(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let max = events[0];
  for (let i = 1; i < events.length; i++) {
    if (compareEvents(max, events[i]) < 0) max = events[i];
  }
  return { ts: max.ts, id: max.id };
}
