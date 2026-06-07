import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TokenBucketLimiter,
  SlidingWindowLimiter,
  createRateLimiter,
} from '../src/quota/ratelimit.js';
import { ConnectionTracker } from '../src/quota/connections.js';

/**
 * SCP-156 + SCP-158 — pure-logic unit tests. No external services; the clock is
 * injected (`now` passed in) so nothing calls Date.now in the tested path.
 */

/* ----------------------- token bucket (per-principal) ----------------------- */

test('token bucket: allows up to capacity, then denies with a retry hint', () => {
  const lim = new TokenBucketLimiter({ capacity: 3, refillPerSec: 1 });
  const t0 = 1_000_000;
  assert.equal(lim.take('sub', { now: t0 }).allowed, true);
  assert.equal(lim.take('sub', { now: t0 }).allowed, true);
  assert.equal(lim.take('sub', { now: t0 }).allowed, true);
  const denied = lim.take('sub', { now: t0 });
  assert.equal(denied.allowed, false);
  // 1 token short at 1 tok/s => ~1000ms.
  assert.equal(denied.retryAfterMs, 1000);
});

test('token bucket: refills over time, capped at capacity', () => {
  const lim = new TokenBucketLimiter({ capacity: 2, refillPerSec: 1 });
  const t0 = 0;
  lim.take('sub', { now: t0 });
  lim.take('sub', { now: t0 }); // drained
  assert.equal(lim.take('sub', { now: t0 }).allowed, false);
  // 1s later -> 1 token back.
  assert.equal(lim.take('sub', { now: t0 + 1000 }).allowed, true);
  assert.equal(lim.take('sub', { now: t0 + 1000 }).allowed, false);
  // 10s later -> capped at 2, not 10.
  assert.equal(lim.take('sub', { now: t0 + 11_000 }).allowed, true);
  assert.equal(lim.take('sub', { now: t0 + 11_000 }).allowed, true);
  assert.equal(lim.take('sub', { now: t0 + 11_000 }).allowed, false);
});

test('token bucket: principals have independent buckets', () => {
  const lim = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1 });
  assert.equal(lim.take('a', { now: 0 }).allowed, true);
  assert.equal(lim.take('a', { now: 0 }).allowed, false);
  assert.equal(lim.take('b', { now: 0 }).allowed, true); // unaffected
});

test('token bucket: fails closed on missing principal', () => {
  const lim = new TokenBucketLimiter({ capacity: 100, refillPerSec: 100 });
  assert.equal(lim.take(null, { now: 0 }).allowed, false);
  assert.equal(lim.take('', { now: 0 }).allowed, false);
});

test('token bucket: requires injected now', () => {
  const lim = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1 });
  assert.throws(() => lim.take('sub'), /pass now/);
});

test('token bucket: sweep evicts idle full buckets', () => {
  const lim = new TokenBucketLimiter({ capacity: 2, refillPerSec: 1, idleEvictMs: 1000 });
  lim.take('sub', { now: 0 });
  assert.equal(lim.buckets.size, 1);
  lim.sweep(2000); // refilled to full + idle > 1000ms
  assert.equal(lim.buckets.size, 0);
});

/* ----------------------- sliding window (per-tenant) ----------------------- */

test('sliding window: caps admissions per window, then denies', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 2 });
  assert.equal(lim.check('t', { now: 0 }).allowed, true);
  assert.equal(lim.check('t', { now: 100 }).allowed, true);
  const d = lim.check('t', { now: 200 });
  assert.equal(d.allowed, false);
  assert.equal(d.retryAfterMs, 800); // oldest (t=0) ages out at 1000
});

test('sliding window: old hits age out', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 1 });
  assert.equal(lim.check('t', { now: 0 }).allowed, true);
  assert.equal(lim.check('t', { now: 500 }).allowed, false);
  assert.equal(lim.check('t', { now: 1001 }).allowed, true); // t=0 expired
});

test('sliding window: denied requests do not extend the window', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 1 });
  lim.check('t', { now: 0 });
  lim.check('t', { now: 100 }); // denied, not recorded
  lim.check('t', { now: 200 }); // denied, not recorded
  // Only the t=0 hit counts, so it ages out at exactly 1000.
  assert.equal(lim.check('t', { now: 1000 }).allowed, true);
});

test('sliding window: fails closed on missing tenant', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 100 });
  assert.equal(lim.check(null, { now: 0 }).allowed, false);
});

/* ----------------------- combined limiter ----------------------- */

test('combined: principal deny does not consume tenant window', () => {
  const rl = createRateLimiter({
    principal: { capacity: 1, refillPerSec: 1 },
    tenant: { windowMs: 1000, max: 5 },
  });
  assert.equal(rl.evaluate({ principal: 'p', tenant: 't', now: 0 }).allowed, true);
  const denied = rl.evaluate({ principal: 'p', tenant: 't', now: 0 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.layer, 'principal');
  // Tenant window should only have 1 hit recorded (the allowed one).
  assert.equal(rl.tenantLimiter.hits.get('t').length, 1);
});

test('combined: tenant ceiling trips even when each principal is under bucket', () => {
  const rl = createRateLimiter({
    principal: { capacity: 100, refillPerSec: 100 },
    tenant: { windowMs: 1000, max: 2 },
  });
  assert.equal(rl.evaluate({ principal: 'a', tenant: 't', now: 0 }).allowed, true);
  assert.equal(rl.evaluate({ principal: 'b', tenant: 't', now: 0 }).allowed, true);
  const denied = rl.evaluate({ principal: 'c', tenant: 't', now: 0 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.layer, 'tenant');
});

/* ----------------------- connection tracker (SCP-158) ----------------------- */

test('connections: acquires up to ceiling, then denies', () => {
  const tr = new ConnectionTracker({ ceiling: 2 });
  assert.equal(tr.acquire('t').allowed, true);
  assert.equal(tr.acquire('t').allowed, true);
  const denied = tr.acquire('t');
  assert.equal(denied.allowed, false);
  assert.equal(denied.count, 2);
});

test('connections: release frees a slot and is idempotent', () => {
  const tr = new ConnectionTracker({ ceiling: 1 });
  const a = tr.acquire('t');
  assert.equal(a.allowed, true);
  assert.equal(tr.acquire('t').allowed, false);
  a.release();
  a.release(); // idempotent — must not over-decrement
  assert.equal(tr.count('t'), 0);
  assert.equal(tr.acquire('t').allowed, true);
});

test('connections: per-tenant isolation + total', () => {
  const tr = new ConnectionTracker({ ceiling: 5 });
  tr.acquire('a'); tr.acquire('a'); tr.acquire('b');
  assert.equal(tr.count('a'), 2);
  assert.equal(tr.count('b'), 1);
  assert.equal(tr.total(), 3);
});

test('connections: fails closed on missing tenant; denied release is a no-op', () => {
  const tr = new ConnectionTracker({ ceiling: 5 });
  const r = tr.acquire(null);
  assert.equal(r.allowed, false);
  r.release(); // no-op, must not corrupt counts
  assert.equal(tr.total(), 0);
});

test('connections: ceiling must be a positive integer', () => {
  assert.throws(() => new ConnectionTracker({ ceiling: 0 }));
  assert.throws(() => new ConnectionTracker({ ceiling: 1.5 }));
});
