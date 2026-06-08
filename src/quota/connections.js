/**
 * SCP-158 — per-tenant concurrent SSE connection ceiling.
 *
 * Tracks live /events connections per tenant in an in-memory map and rejects a
 * new connection once the tenant is at its ceiling. The default ceiling is
 * derived from the per-node connection benchmark in SCP-150 so that summed
 * tenant ceilings stay within tested node capacity.
 *
 * SCOPE / MULTI-NODE CAVEAT: this is a single-process in-memory tracker. With
 * more than one relay node behind a load balancer, each node only sees its own
 * share of a tenant's connections, so the effective per-tenant ceiling becomes
 * (ceiling x nodeCount). For a true global ceiling, back this with a shared
 * store (e.g. a Redis INCR/DECR keyed by tenant, or a Postgres advisory
 * counter) and swap acquire/release for the shared ops — the interface
 * (acquire -> handle, handle.release()) is designed to stay the same.
 *
 * USAGE at the /events handler (see INTEGRATION INSTRUCTIONS):
 *   const lease = connections.acquire(tenantId);
 *   if (!lease.allowed) { res.writeHead(429, {'Retry-After':'5'}); return res.end(); }
 *   req.on('close', () => lease.release());
 *
 * release() is idempotent, so wiring it on both 'close' and an error path is
 * safe.
 */

export class ConnectionTracker {
  /**
   * @param {object} opts
   * @param {number} opts.ceiling - max concurrent connections per tenant.
   */
  constructor({ ceiling } = {}) {
    if (!Number.isInteger(ceiling) || ceiling <= 0) {
      throw new Error('ConnectionTracker: ceiling must be a positive integer');
    }
    this.ceiling = ceiling;
    this.counts = new Map(); // tenant -> active count
  }

  /** Current live count for a tenant. */
  count(tenant) {
    return this.counts.get(tenant) ?? 0;
  }

  /**
   * Try to acquire a connection slot for `tenant`.
   *
   * FAIL CLOSED: a missing tenant is denied — an unattributable SSE connection
   * doesn't get an uncounted slot.
   *
   * @returns {{allowed: boolean, count: number, ceiling: number, release: ()=>void, retryAfterMs?: number}}
   *   On allow, `release` decrements exactly once. On deny, `release` is a no-op.
   */
  acquire(tenant) {
    if (tenant == null || tenant === '') {
      return { allowed: false, count: 0, ceiling: this.ceiling, retryAfterMs: 5000, release: () => {} };
    }
    const current = this.count(tenant);
    if (current >= this.ceiling) {
      return { allowed: false, count: current, ceiling: this.ceiling, retryAfterMs: 5000, release: () => {} };
    }
    const next = current + 1;
    this.counts.set(tenant, next);

    let released = false;
    const release = () => {
      if (released) return; // idempotent
      released = true;
      const c = this.count(tenant);
      if (c <= 1) this.counts.delete(tenant);
      else this.counts.set(tenant, c - 1);
    };
    return { allowed: true, count: next, ceiling: this.ceiling, release };
  }

  /** Total live connections across all tenants (node-load visibility). */
  total() {
    let n = 0;
    for (const c of this.counts.values()) n += c;
    return n;
  }

  reset(tenant) { this.counts.delete(tenant); }
  resetAll() { this.counts.clear(); }
}

/**
 * Default ceiling. Placeholder pending the SCP-150 per-node benchmark: pick a
 * per-tenant ceiling such that (ceiling x expectedTenantsPerNode) stays under
 * the measured safe concurrent-connection count for one node. Overridable via
 * SCOPE_SSE_TENANT_CEILING.
 */
export const DEFAULT_TENANT_CEILING = Number(process.env.SCOPE_SSE_TENANT_CEILING) || 20;

/** Construct the per-server tracker. */
export function createConnectionTracker(ceiling = DEFAULT_TENANT_CEILING) {
  return new ConnectionTracker({ ceiling });
}
