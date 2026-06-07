/**
 * SCP-156 — per-principal + per-tenant rate limiting.
 *
 * Two layers, mounted after authMiddleware in server.js (see INTEGRATION
 * INSTRUCTIONS in the SCP-156 delivery notes) and BEFORE workspace resolution:
 *
 *  1. A per-principal TOKEN BUCKET keyed on the authenticated principal
 *     (auth.sub). Sized for fleets: a steady refill rate with a burst
 *     capacity, so a 6-agent fleet stays under the cap but a runaway loop
 *     drains the bucket and trips. The acting model ("Opus 4.8") is metadata,
 *     NOT a key — agents share the principal's bucket (per SCP-127's design).
 *
 *  2. A per-tenant SLIDING-WINDOW aggregate ceiling. Bounds the summed request
 *     rate across every principal in a tenant, so one tenant can't exhaust the
 *     node even if each individual principal is under its own bucket.
 *
 * Both return the {allowed, retryAfterMs} shape from src/pair.js (RateLimiter),
 * so the caller maps a deny to 429 + Retry-After exactly like the pairing path.
 *
 * FAIL CLOSED: a missing/unidentifiable principal or tenant is denied, not
 * allowed. The middleware never lets an unkeyable request through.
 *
 * PURE LOGIC IS CLOCK-INJECTABLE: every method takes `now` (ms epoch) so the
 * unit tests drive time deterministically and never call Date.now in the
 * tested path. The Express adapter at the bottom is the only place Date.now is
 * read, and it's a thin wrapper.
 */

/* ------------------------------------------------------------------ *
 * Layer 1: per-principal token bucket
 * ------------------------------------------------------------------ */

/**
 * Lazily-refilled token bucket per principal.
 *
 * @param {object} opts
 * @param {number} opts.capacity      - max tokens (burst ceiling)
 * @param {number} opts.refillPerSec  - tokens added per second (steady rate)
 * @param {number} [opts.idleEvictMs] - drop a bucket from the map once it has
 *   been full and untouched this long (prevents unbounded growth). Default 10m.
 */
export class TokenBucketLimiter {
  constructor({ capacity, refillPerSec, idleEvictMs = 10 * 60_000 } = {}) {
    if (!(capacity > 0) || !(refillPerSec > 0)) {
      throw new Error('TokenBucketLimiter: capacity and refillPerSec must be > 0');
    }
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.idleEvictMs = idleEvictMs;
    this.buckets = new Map(); // principal -> { tokens, updatedAt }
  }

  /**
   * Attempt to spend `cost` tokens for `principal`.
   * @returns {{allowed: boolean, retryAfterMs?: number, remaining?: number}}
   */
  take(principal, { now, cost = 1 } = {}) {
    if (typeof now !== 'number') throw new Error('take: pass now (ms epoch)');
    // FAIL CLOSED: no identifiable principal => deny. Unkeyable traffic must
    // not get a free pass; the bucket only protects what it can name.
    if (principal == null || principal === '') {
      return { allowed: false, retryAfterMs: 1000 };
    }

    let b = this.buckets.get(principal);
    if (!b) {
      b = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(principal, b);
    } else {
      // Refill for elapsed time, capped at capacity.
      const elapsedSec = Math.max(0, (now - b.updatedAt) / 1000);
      b.tokens = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
      b.updatedAt = now;
    }

    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, remaining: Math.floor(b.tokens) };
    }

    // Not enough tokens — compute when `cost` will be available again.
    const deficit = cost - b.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillPerSec) * 1000);
    return { allowed: false, retryAfterMs, remaining: Math.floor(b.tokens) };
  }

  /** Evict idle, full buckets so the map doesn't grow unbounded. */
  sweep(now) {
    if (typeof now !== 'number') throw new Error('sweep: pass now (ms epoch)');
    for (const [principal, b] of this.buckets) {
      const elapsedSec = Math.max(0, (now - b.updatedAt) / 1000);
      const projected = Math.min(this.capacity, b.tokens + elapsedSec * this.refillPerSec);
      if (projected >= this.capacity && now - b.updatedAt >= this.idleEvictMs) {
        this.buckets.delete(principal);
      }
    }
  }

  reset(principal) { this.buckets.delete(principal); }
  resetAll() { this.buckets.clear(); }
}

/* ------------------------------------------------------------------ *
 * Layer 2: per-tenant sliding-window ceiling
 * ------------------------------------------------------------------ */

/**
 * Sliding-window request ceiling per tenant. Same algorithm as
 * src/pair.js RateLimiter, generalized to a configurable window + max and
 * keyed by tenant rather than IP. Counts *successful admissions* (we push the
 * timestamp only when allowed), so a denied request doesn't extend its own
 * cooldown.
 *
 * @param {object} opts
 * @param {number} opts.windowMs - sliding window width
 * @param {number} opts.max      - max admitted requests per window per tenant
 */
export class SlidingWindowLimiter {
  constructor({ windowMs, max } = {}) {
    if (!(windowMs > 0) || !(max > 0)) {
      throw new Error('SlidingWindowLimiter: windowMs and max must be > 0');
    }
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // tenant -> number[] (timestamps, ascending)
  }

  /** @returns {{allowed: boolean, retryAfterMs?: number, remaining?: number}} */
  check(tenant, { now } = {}) {
    if (typeof now !== 'number') throw new Error('check: pass now (ms epoch)');
    // FAIL CLOSED: no tenant => deny.
    if (tenant == null || tenant === '') {
      return { allowed: false, retryAfterMs: this.windowMs };
    }
    const cutoff = now - this.windowMs;
    let arr = this.hits.get(tenant);
    if (!arr) { arr = []; this.hits.set(tenant, arr); }
    while (arr.length && arr[0] <= cutoff) arr.shift();

    if (arr.length >= this.max) {
      // Oldest hit ages out of the window at arr[0] + windowMs.
      return { allowed: false, retryAfterMs: (arr[0] + this.windowMs) - now };
    }
    arr.push(now);
    return { allowed: true, remaining: this.max - arr.length };
  }

  reset(tenant) { this.hits.delete(tenant); }
  resetAll() { this.hits.clear(); }
}

/* ------------------------------------------------------------------ *
 * Combined limiter + Express middleware adapter
 * ------------------------------------------------------------------ */

/**
 * Default sizing (from SCP-127's design: "5 req/s burst 50" per principal so a
 * 6-agent fleet is fine but a runaway loop trips). Per-tenant ceiling is the
 * aggregate cap; tune against the SCP-150 node benchmark.
 */
export const DEFAULTS = {
  principal: { capacity: 50, refillPerSec: 5 },
  tenant: { windowMs: 1000, max: 200 },
};

/**
 * Build a combined limiter. Pure logic — caller supplies `now` to every call,
 * which keeps it unit-testable.
 */
export function createRateLimiter({ principal = DEFAULTS.principal, tenant = DEFAULTS.tenant } = {}) {
  const principalLimiter = new TokenBucketLimiter(principal);
  const tenantLimiter = new SlidingWindowLimiter(tenant);

  /**
   * Evaluate both layers. Principal bucket is checked first (cheaper, and the
   * common runaway case). On a principal deny we do NOT touch the tenant window
   * — a denied request shouldn't count against the tenant aggregate.
   *
   * @returns {{allowed, retryAfterMs?, layer?, remaining?}}
   */
  function evaluate({ principal: sub, tenant: tnt, now, cost = 1 }) {
    const p = principalLimiter.take(sub, { now, cost });
    if (!p.allowed) return { ...p, layer: 'principal' };
    const t = tenantLimiter.check(tnt, { now });
    if (!t.allowed) return { ...t, layer: 'tenant' };
    return { allowed: true, layer: null, remaining: Math.min(p.remaining ?? Infinity, t.remaining ?? Infinity) };
  }

  return { evaluate, principalLimiter, tenantLimiter };
}

/**
 * Express middleware. The ONLY place Date.now is read for rate limiting.
 *
 * Resolves principal + tenant from the request via the supplied resolvers
 * (defaults assume authMiddleware populated req.auth.sub and a tenant on
 * req.auth.tenant / req.tenantId — adjust resolvers to match the SCP-122 claim
 * shape that actually lands). FAIL CLOSED: if either resolver returns null the
 * underlying limiter denies.
 *
 * @param {object} opts
 * @param {ReturnType<typeof createRateLimiter>} [opts.limiter]
 * @param {(req)=>string|null} [opts.getPrincipal]
 * @param {(req)=>string|null} [opts.getTenant]
 */
export function rateLimitMiddleware({
  limiter = createRateLimiter(),
  getPrincipal = (req) => req.auth?.sub ?? req.device?.serial_hex ?? null,
  getTenant = (req) => req.auth?.tenant ?? req.tenantId ?? req.query?.workspace ?? null,
  now = () => Date.now(),
} = {}) {
  return (req, res, next) => {
    const result = limiter.evaluate({
      principal: getPrincipal(req),
      tenant: getTenant(req),
      now: now(),
    });
    if (result.allowed) {
      if (typeof result.remaining === 'number' && Number.isFinite(result.remaining)) {
        res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      }
      return next();
    }
    const retrySec = Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000));
    res.setHeader('Retry-After', String(retrySec));
    return res.status(429).json({
      error: 'rate limited',
      layer: result.layer,
      retryAfterMs: result.retryAfterMs,
    });
  };
}
