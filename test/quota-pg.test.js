import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { ensureSchema } from '../src/pg/schema.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import {
  ensureQuotaSchema,
  dropQuotaSchema,
  getLimits,
  recordEvents,
  eventsToday,
  recordSeat,
  seatCount,
  storageBytes,
  checkEventQuota,
  checkSeatQuota,
  classify,
  FREE_TIER,
  utcDay,
} from '../src/quota/quota.js';
import { getUsage } from '../src/quota/usage.js';
import { applyPlan, downgradeToFree, planForPrice, PLAN_CATALOG } from '../src/quota/billing.js';

/**
 * SCP-157 (quota enforcement + metering) and SCP-160 (plan persistence) against
 * real Postgres. Skips cleanly when none is reachable:
 *   docker compose up -d
 *   SCOPE_PG_URL=postgres://scope:scope@localhost:5433/scope_test npm test
 *
 * Tenant ids are prefixed "quota_" per the hosted-Scope test convention.
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

async function freshTenant(pool, name) {
  const T = `quota_${name}`;
  await pool.query('DELETE FROM tenant_event_usage WHERE tenant_id=$1', [T]);
  await pool.query('DELETE FROM tenant_seats WHERE tenant_id=$1', [T]);
  await pool.query('DELETE FROM tenant_plan WHERE tenant_id=$1', [T]);
  await pool.query('DELETE FROM events WHERE tenant_id=$1', [T]);
  return T;
}

/* ----------------------- pure (no PG) ----------------------- */

test('classify: warn at >=80% and <100%, exceeded at cap', () => {
  assert.deepEqual(
    { warn: classify(79, 100).warn, ex: classify(79, 100).exceeded }, { warn: false, ex: false });
  assert.deepEqual(
    { warn: classify(80, 100).warn, ex: classify(80, 100).exceeded }, { warn: true, ex: false });
  assert.deepEqual(
    { warn: classify(100, 100).warn, ex: classify(100, 100).exceeded }, { warn: false, ex: true });
});

test('planForPrice: maps a catalog price; unknown -> null', () => {
  const known = Object.keys(PLAN_CATALOG)[0];
  assert.ok(planForPrice(known));
  assert.equal(planForPrice('price_nope'), null);
});

/* ----------------------- PG-backed ----------------------- */

test('ensureQuotaSchema is idempotent', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool);
  await ensureQuotaSchema(pool);
  await ensureQuotaSchema(pool);
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`
  );
  const names = rows.map((r) => r.table_name);
  for (const t of ['tenant_plan', 'tenant_event_usage', 'tenant_seats'])
    assert.ok(names.includes(t), `${t} exists`);
});

test('getLimits falls back to FREE_TIER with no plan row', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool); await ensureQuotaSchema(pool);
  const T = await freshTenant(pool, 'free');
  const limits = await getLimits(pool, T);
  assert.equal(limits.plan, 'free');
  assert.equal(limits.limit_events_day, FREE_TIER.limit_events_day);
});

test('recordEvents accumulates per UTC day; re-uploads (delta 0) are no-ops', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool); await ensureQuotaSchema(pool);
  const T = await freshTenant(pool, 'events');
  assert.equal(await recordEvents(pool, T, 3), 3);
  assert.equal(await recordEvents(pool, T, 2), 5);
  assert.equal(await recordEvents(pool, T, 0), 5); // re-upload applied 0 -> no change
  assert.equal(await eventsToday(pool, T), 5);
});

test('checkEventQuota hard-rejects at cap and warns at 80%', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool); await ensureQuotaSchema(pool);
  const T = await freshTenant(pool, 'evcap');
  // Set a tiny limit via a plan row.
  await applyPlan(pool, T, {
    plan: 'pro',
    limits: { limit_events_day: 10, limit_projects: 1, limit_seats: 2, limit_storage_bytes: 1024 },
  });
  await recordEvents(pool, T, 7);
  const warn = await checkEventQuota(pool, T, 1); // 7->8 = 80%
  assert.equal(warn.allowed, true);
  assert.equal(warn.warn, true);
  const reject = await checkEventQuota(pool, T, 5); // 7+5=12 > 10
  assert.equal(reject.allowed, false);
  assert.equal(reject.reason, 'events_day');
});

test('seats: recordSeat is idempotent; checkSeatQuota enforces the cap', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool); await ensureQuotaSchema(pool);
  const T = await freshTenant(pool, 'seats');
  // free tier = 2 seats
  assert.equal(await recordSeat(pool, T, 'alice'), 1);
  assert.equal(await recordSeat(pool, T, 'alice'), 1); // idempotent
  assert.equal(await recordSeat(pool, T, 'bob'), 2);
  assert.equal(await seatCount(pool, T), 2);
  // adding an existing seat is always allowed
  assert.equal((await checkSeatQuota(pool, T, 'alice')).allowed, true);
  // a third NEW seat exceeds the free cap
  const reject = await checkSeatQuota(pool, T, 'carol');
  assert.equal(reject.allowed, false);
  assert.equal(reject.reason, 'seats');
});

test('storageBytes reflects event-log body size', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool); await ensureQuotaSchema(pool);
  const T = await freshTenant(pool, 'storage');
  assert.equal(await storageBytes(pool, T), 0);
  const evt = { v: 1, id: 'E'.repeat(26), ts: '2026-06-07T00:00:00.000Z', actor: 'bri', kind: 'ticket.delete', payload: { ticketId: 'X'.repeat(26) } };
  await pool.query(
    `INSERT INTO events (tenant_id,event_id,ts,kind,body) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT DO NOTHING`,
    [T, evt.id, evt.ts, evt.kind, evt]
  );
  assert.ok(await storageBytes(pool, T) > 0);
});

test('getUsage summarizes every dimension vs limits with a warn flag', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool); await ensureQuotaSchema(pool);
  const T = await freshTenant(pool, 'usage');
  await applyPlan(pool, T, {
    plan: 'pro',
    limits: { limit_events_day: 10, limit_projects: 5, limit_seats: 5, limit_storage_bytes: 1_000_000 },
  });
  await recordEvents(pool, T, 9); // 90% -> warn
  await recordSeat(pool, T, 'alice');
  const u = await getUsage(pool, T);
  assert.equal(u.plan, 'pro');
  assert.equal(u.dimensions.events_day.used, 9);
  assert.equal(u.dimensions.events_day.limit, 10);
  assert.equal(u.dimensions.events_day.warn, true);
  assert.equal(u.dimensions.seats.used, 1);
  assert.equal(u.warn, true); // some dimension is warning
});

test('applyPlan UPSERTs limits; downgradeToFree removes the row', { skip }, async () => {
  const pool = getPool();
  await ensureSchema(pool); await ensureQuotaSchema(pool);
  const T = await freshTenant(pool, 'plan');
  await applyPlan(pool, T, {
    plan: 'team',
    limits: { limit_events_day: 999, limit_projects: 9, limit_seats: 9, limit_storage_bytes: 9 },
    stripeCustomerId: 'cus_x', stripeSubscriptionId: 'sub_x',
  });
  let limits = await getLimits(pool, T);
  assert.equal(limits.plan, 'team');
  assert.equal(limits.limit_events_day, 999);
  // upsert overwrites
  await applyPlan(pool, T, {
    plan: 'pro',
    limits: { limit_events_day: 100, limit_projects: 1, limit_seats: 1, limit_storage_bytes: 1 },
  });
  limits = await getLimits(pool, T);
  assert.equal(limits.plan, 'pro');
  // downgrade -> free fallback
  await downgradeToFree(pool, T);
  limits = await getLimits(pool, T);
  assert.equal(limits.plan, 'free');
});

test.after(async () => { await closePool(); });
