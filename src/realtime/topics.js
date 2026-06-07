/**
 * Per-tenant / per-project topic routing + subscribe-time isolation (SCP-148).
 *
 * In the local hub the SSE endpoint filtered by an opaque `?workspace=` query
 * param (server.js ~L562) — trusting whatever the client asked for. In the
 * hosted relay a project IS a tenant (ADR 0003), and the tenant a connection is
 * allowed to see is fixed by the authenticated principal (SCP-122/131), NOT by
 * a query param. This module derives the bus topic from the principal and
 * provides the guard that makes cross-tenant leakage impossible at subscribe
 * time.
 *
 * Topic grammar:  scope.<tenant>            — every event in the tenant/project
 *                 scope.<tenant>.<project>  — reserved for future sub-project
 *                                             scoping (a tenant may host >1
 *                                             project once SCP-131 lands)
 *
 * The bus (bus.js) treats topics as opaque strings and hashes them to a channel;
 * the isolation contract lives here.
 */

/** A tenant/project id segment must be a safe, bounded token (no separators). */
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

function assertSegment(name, value) {
  if (typeof value !== 'string' || !SEGMENT.test(value)) {
    throw new Error(`invalid ${name}: must match ${SEGMENT}`);
  }
}

/**
 * Derive the bus topic a principal is allowed to subscribe to.
 *
 * The principal is the authenticated identity (SCP-122) carrying its tenant —
 * NOT anything the client passed on the query string. A requested project is
 * accepted only when it belongs to the principal's tenant; otherwise we throw
 * rather than silently widen scope.
 *
 * @param {object} principal - { tenant, projects? } from auth middleware.
 * @param {object} [opts]
 * @param {string} [opts.project] - optional narrower scope the client asked for.
 * @returns {string} the topic to pass to bus.subscribe().
 */
export function topicForPrincipal(principal, { project } = {}) {
  if (!principal || typeof principal !== 'object') {
    throw new Error('topicForPrincipal requires an authenticated principal');
  }
  const tenant = principal.tenant;
  assertSegment('tenant', tenant);

  if (project == null) return `scope.${tenant}`;

  assertSegment('project', project);
  // A client may only narrow to a project that belongs to its own tenant.
  if (Array.isArray(principal.projects) && !principal.projects.includes(project)) {
    throw new Error('principal is not a member of the requested project');
  }
  return `scope.${tenant}.${project}`;
}

/**
 * The topic a writer publishes to when it accepts events for a tenant. Mirrors
 * the subscribe-side derivation so a publish always lands on the tenant-wide
 * topic that every subscriber in the tenant is listening on.
 *
 * @param {string} tenant
 */
export function topicForTenant(tenant) {
  assertSegment('tenant', tenant);
  return `scope.${tenant}`;
}

/** Extract the tenant segment from a topic. Returns null if it's not a scope topic. */
export function tenantOfTopic(topic) {
  if (typeof topic !== 'string') return null;
  const m = /^scope\.([A-Za-z0-9_-]{1,128})(?:\.[A-Za-z0-9_-]{1,128})?$/.exec(topic);
  return m ? m[1] : null;
}

/**
 * Subscribe-time isolation guard. Returns a predicate that a subscriber wraps
 * its callback in, so even if the bus mis-routed a message (hash collision,
 * future backend bug, a NATS wildcard that's too broad) a node NEVER forwards
 * another tenant's payload to a connection.
 *
 * The payload Scope ships is a pointer `{ tenant, cursor }`; the guard asserts
 * that pointer's tenant equals the principal's tenant. Defense in depth on top
 * of the exact-topic match in bus.subscribe().
 *
 * @param {object} principal - { tenant }
 * @returns {(payload: any) => boolean} true iff the payload is in-tenant.
 */
export function isolationGuard(principal) {
  const tenant = principal?.tenant;
  assertSegment('tenant', tenant);
  return (payload) => {
    // No tenant on the pointer → reject; we never fan out un-attributed events.
    const t = payload && typeof payload === 'object' ? payload.tenant : undefined;
    return t === tenant;
  };
}

/**
 * Convenience: wrap a delivery callback with the isolation guard so a leaked
 * cross-tenant message is dropped before it reaches the SSE response.
 *
 * @param {object} principal
 * @param {(payload:any)=>void} cb
 */
export function guardedDelivery(principal, cb) {
  const allow = isolationGuard(principal);
  return (payload) => {
    if (allow(payload)) cb(payload);
  };
}
