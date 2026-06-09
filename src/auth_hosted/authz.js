/**
 * Event-upload authorization (SCP-132) — the on-ingest gate for the sync push
 * path (SCP-134 / src/pg/store.js uploadEvents).
 *
 * ADR 0003 §4: reject any event whose actor-principal differs from the
 * authenticated subject, or where the subject lacks write role on the target
 * project. This module owns the actor-vs-principal half; the role half is a
 * membership.hasRole(tenant, principal, 'member') check the caller does before
 * (or the combined `authorizeUpload` does it for you if given a pool).
 *
 * CRITICAL actor semantics (SCP-128): in an event envelope the raw `actor`
 * field IS the human principal — nothing else. The acting model lives in the
 * SEPARATE `model` field. "{model} on behalf of {user}" is a DISPLAY rendering
 * (formatActor) produced at replay time; it is NEVER the stored `actor`. So:
 *
 *   - The authenticated principal is a bare account identifier (e.g. "bri" /
 *     "acct_ab12"). We compare it against `event.actor` directly.
 *   - We DEFENSIVELY reject any event whose raw `actor` contains the
 *     " on behalf of " marker: a well-formed event never stores the rendered
 *     form there, so its presence means a client tried to smuggle the display
 *     string into the principal slot to impersonate someone.
 *
 * The function is pure (no DB) for the actor check, so accept/reject unit-tests
 * without Postgres. Role enforcement is opt-in via the `checkRole` callback.
 */

export const ON_BEHALF_MARKER = ' on behalf of ';

/** A raw `actor` must be the bare principal — never the rendered display form. */
function looksRendered(actor) {
  return typeof actor === 'string' && actor.includes(ON_BEHALF_MARKER);
}

/**
 * Authorize a batch of events for upload by `principal`.
 *
 * @param {Array<object>} events - event envelopes ({actor, model?, ...})
 * @param {string} principal - the authenticated human account id (the JWT
 *   `sub` or the API key's account). Must equal each event's raw `actor` —
 *   or, when `opts.allowedActors` is given, be in that set (SCP-184: the
 *   caller passes the principal's per-project alias set, so a local log
 *   stamped "bri" can sync under the account that claimed that alias).
 * @param {object} [opts]
 * @param {Set<string>} [opts.allowedActors] - additional acceptable actor
 *   strings for this principal on this tenant (alias map). The principal
 *   itself is always acceptable.
 * @returns {{ ok: true } | { ok: false, code: string, message: string, eventId?: string }}
 *
 * Reject codes (the error contract shared with the SCP-134 push protocol):
 *   - ACTOR_MISMATCH       — an event's actor != authenticated principal
 *   - ACTOR_RENDERED       — an event smuggled "{model} on behalf of {user}"
 *                            into the raw actor field (impersonation attempt)
 *   - ACTOR_MISSING        — an event had no actor (defense-in-depth; the event
 *                            validator already requires one)
 *   - PRINCIPAL_MISSING    — no authenticated principal supplied
 */
export function authorizeUploadActors(events, principal, { allowedActors } = {}) {
  if (typeof principal !== 'string' || !principal) {
    return { ok: false, code: 'PRINCIPAL_MISSING', message: 'no authenticated principal' };
  }
  if (looksRendered(principal)) {
    // The principal itself must be a bare account id, not a rendered string.
    return { ok: false, code: 'PRINCIPAL_MISSING', message: 'principal must be a bare account id' };
  }
  if (!Array.isArray(events)) {
    return { ok: false, code: 'ACTOR_MISSING', message: 'events must be an array' };
  }
  for (const e of events) {
    const actor = e && e.actor;
    if (typeof actor !== 'string' || !actor) {
      return { ok: false, code: 'ACTOR_MISSING', message: 'event missing actor', eventId: e?.id };
    }
    if (looksRendered(actor)) {
      return {
        ok: false,
        code: 'ACTOR_RENDERED',
        message: `event actor must be a bare principal, not a rendered "${ON_BEHALF_MARKER.trim()}" string`,
        eventId: e.id,
      };
    }
    if (actor !== principal && !(allowedActors instanceof Set && allowedActors.has(actor))) {
      return {
        ok: false,
        code: 'ACTOR_MISMATCH',
        message: `event actor "${actor}" != authenticated principal "${principal}" (claim it as an alias to sync local history)`,
        eventId: e.id,
      };
    }
  }
  return { ok: true };
}

/**
 * Full upload authorization: actor check (always) + optional write-role check.
 *
 * @param {Array<object>} events
 * @param {string} principal - authenticated human account id
 * @param {object} [opts]
 * @param {() => (boolean|Promise<boolean>)} [opts.checkRole] - resolves true iff
 *   `principal` has write (≥member) role on the target tenant. When omitted the
 *   role gate is skipped (caller enforced it separately).
 * @returns {Promise<{ ok: true } | { ok: false, code: string, message: string, eventId?: string }>}
 */
export async function authorizeUpload(events, principal, { checkRole, allowedActors } = {}) {
  const actorResult = authorizeUploadActors(events, principal, { allowedActors });
  if (!actorResult.ok) return actorResult;
  if (typeof checkRole === 'function') {
    const allowed = await checkRole();
    if (!allowed) {
      return { ok: false, code: 'FORBIDDEN_ROLE', message: 'principal lacks write role on target project' };
    }
  }
  return { ok: true };
}

/** Map a reject result to an HTTP status for the push endpoint. */
export function statusForReject(code) {
  switch (code) {
    case 'PRINCIPAL_MISSING': return 401;
    case 'FORBIDDEN_ROLE': return 403;
    default: return 403; // ACTOR_MISMATCH / ACTOR_RENDERED / ACTOR_MISSING
  }
}
