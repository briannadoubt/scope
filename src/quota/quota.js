/**
 * SCP-157 — per-tenant quota enforcement + usage metering.
 *
 * Per-tenant counters maintained alongside the Postgres event log (SCP-124/139).
 * Four quota dimensions (SCP-127):
 *   - events/day  : rolling daily event-apply count. We count ONLY newly-applied
 *                   events on the ON CONFLICT upload (uploadEvents already
 *                   returns that delta), so re-uploads don't double-charge.
 *   - projects    : number of projects (= tenants) owned by the billing account.
 *   - seats       : distinct principals with access.
 *   - storage     : bytes of event-log body stored for the tenant.
 *
 * Soft-warn at >= 80% of the cap; hard-reject at the cap. Limits come from the
 * tenant's resolved plan row (SCP-160 writes plan/tier; getLimits reads it),
 * with a free-tier default so a tenant with no billing row still has bounds.
 *
 * PRICING-AGNOSTIC: limits are just numbers on a row. SCP-160 may set them
 * per-project, per-seat, or per-usage — this module only reads + enforces them,
 * so swapping the pricing UNIT (SCP-127 open question) needs no change here.
 *
 * The DDL (QUOTA_SCHEMA_SQL) is additive and idempotent — it does NOT touch the
 * SCP-140 tables. Mount it alongside ensureSchema (see INTEGRATION INSTRUCTIONS).
 */

/* ------------------------------------------------------------------ *
 * DDL — additive to the SCP-140 schema, idempotent.
 * ------------------------------------------------------------------ */

export const QUOTA_SCHEMA_SQL = /* sql */ `
-- Per-tenant resolved plan/limits. SCP-160's Stripe webhook UPSERTs the plan
-- + tier onto this row; the quota checks read limits from here. A tenant with
-- no row falls back to FREE_TIER in code, so billing is never a hard dependency
-- for enforcement to work.
CREATE TABLE IF NOT EXISTS tenant_plan (
  tenant_id          text PRIMARY KEY,
  plan               text NOT NULL DEFAULT 'free',     -- 'free' | 'pro' | ... (SCP-160)
  limit_events_day   integer NOT NULL,                 -- max applied events per UTC day
  limit_projects     integer NOT NULL,                 -- max projects per account (see note)
  limit_seats        integer NOT NULL,                 -- max distinct principals
  limit_storage_bytes bigint NOT NULL,                 -- max event-log body bytes
  -- billing linkage (nullable until SCP-160 lands a customer)
  stripe_customer_id     text,
  stripe_subscription_id text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Rolling per-day event-apply counter. One row per (tenant, UTC day). Bumped by
-- the applied-delta of each upload; the daily quota reads today's row.
CREATE TABLE IF NOT EXISTS tenant_event_usage (
  tenant_id   text NOT NULL,
  usage_date  date NOT NULL,        -- UTC calendar day
  events      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, usage_date)
);

-- Distinct seats (principals) seen for a tenant. Seat = a human principal
-- (auth.sub); the acting model is metadata and never a seat.
CREATE TABLE IF NOT EXISTS tenant_seats (
  tenant_id  text NOT NULL,
  principal  text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal)
);
`;

/** Free-tier defaults (SCP-160 free-tier boundary; overridden by tenant_plan). */
export const FREE_TIER = Object.freeze({
  plan: 'free',
  limit_events_day: 1000,
  limit_projects: 1,
  limit_seats: 2,
  limit_storage_bytes: 25 * 1024 * 1024, // 25 MiB of event-log body
});

export const SOFT_WARN_RATIO = 0.8;

/** Create the quota tables. Idempotent; safe on boot alongside ensureSchema. */
export async function ensureQuotaSchema(clientOrPool) {
  await clientOrPool.query(QUOTA_SCHEMA_SQL);
}

/** Drop quota tables (tests only). */
export async function dropQuotaSchema(clientOrPool) {
  await clientOrPool.query(
    `DROP TABLE IF EXISTS tenant_event_usage, tenant_seats, tenant_plan CASCADE;`
  );
}

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/**
 * Resolve a tenant's limits. Reads tenant_plan; falls back to FREE_TIER when no
 * row exists. Returns the limit set plus the plan name.
 */
export async function getLimits(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT plan, limit_events_day, limit_projects, limit_seats, limit_storage_bytes
       FROM tenant_plan WHERE tenant_id=$1`,
    [tenantId]
  );
  if (!rows.length) return { ...FREE_TIER };
  const r = rows[0];
  return {
    plan: r.plan,
    limit_events_day: Number(r.limit_events_day),
    limit_projects: Number(r.limit_projects),
    limit_seats: Number(r.limit_seats),
    limit_storage_bytes: Number(r.limit_storage_bytes),
  };
}

/* ------------------------------------------------------------------ *
 * Current usage (raw counters)
 * ------------------------------------------------------------------ */

/** Today's applied-event count for a tenant (UTC day). */
export async function eventsToday(pool, tenantId, { day = utcDay() } = {}) {
  const { rows } = await pool.query(
    `SELECT events FROM tenant_event_usage WHERE tenant_id=$1 AND usage_date=$2`,
    [tenantId, day]
  );
  return rows.length ? Number(rows[0].events) : 0;
}

/** Distinct seat count for a tenant. */
export async function seatCount(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT count(*)::bigint AS c FROM tenant_seats WHERE tenant_id=$1`,
    [tenantId]
  );
  return Number(rows[0].c);
}

/** Event-log body bytes for a tenant (storage dimension). */
export async function storageBytes(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sum(pg_column_size(body)),0)::bigint AS b
       FROM events WHERE tenant_id=$1`,
    [tenantId]
  );
  return Number(rows[0].b);
}

/**
 * Project count for the account that owns this tenant. A "project IS a tenant"
 * (ADR 0003), so the per-account project count depends on the
 * account->tenant mapping, which is owned by the auth/identity layer (SCP-122)
 * and not modeled here. Until that mapping lands, treat each tenant as its own
 * single-project account: existence of any plan/usage row => 1, else 0.
 * Swap this for an account-scoped COUNT once the mapping exists.
 */
export async function projectCount(pool, tenantId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM tenant_plan WHERE tenant_id=$1
     UNION SELECT 1 FROM events WHERE tenant_id=$1 LIMIT 1`,
    [tenantId]
  );
  return rows.length ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Metering (writers)
 * ------------------------------------------------------------------ */

/**
 * Record `appliedDelta` newly-applied events against today's counter. Pass the
 * delta uploadEvents() returns (count of rows that actually inserted on the
 * ON CONFLICT upload) so re-uploads contribute 0. UPSERT-accumulates.
 *
 * Returns the running total for the day after the increment.
 */
export async function recordEvents(pool, tenantId, appliedDelta, { day = utcDay() } = {}) {
  if (!appliedDelta) return eventsToday(pool, tenantId, { day });
  const { rows } = await pool.query(
    `INSERT INTO tenant_event_usage (tenant_id, usage_date, events)
       VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, usage_date)
       DO UPDATE SET events = tenant_event_usage.events + EXCLUDED.events
     RETURNING events`,
    [tenantId, day, appliedDelta]
  );
  return Number(rows[0].events);
}

/** Register a principal as a seat (idempotent). Returns the new seat count. */
export async function recordSeat(pool, tenantId, principal) {
  await pool.query(
    `INSERT INTO tenant_seats (tenant_id, principal) VALUES ($1,$2)
     ON CONFLICT (tenant_id, principal) DO NOTHING`,
    [tenantId, principal]
  );
  return seatCount(pool, tenantId);
}

/* ------------------------------------------------------------------ *
 * Enforcement
 * ------------------------------------------------------------------ */

/**
 * Classify a single dimension. Pure helper — no I/O.
 * @returns {{used, limit, ratio, warn: boolean, exceeded: boolean}}
 */
export function classify(used, limit) {
  const ratio = limit > 0 ? used / limit : (used > 0 ? Infinity : 0);
  return {
    used,
    limit,
    ratio,
    warn: ratio >= SOFT_WARN_RATIO && ratio < 1,
    exceeded: used >= limit,
  };
}

/**
 * Pre-flight check before admitting `addEvents` more events for a tenant.
 * Reads today's count + the tenant's events/day limit and decides:
 *   - allowed:false + reason 'events_day' if the new total would exceed the cap
 *   - allowed:true + warn:true if it crosses 80%
 *
 * Hard-rejects BEFORE writing, so a rejected upload meters nothing.
 *
 * @returns {{allowed, warn, reason?, used, projected, limit}}
 */
export async function checkEventQuota(pool, tenantId, addEvents = 1, { day = utcDay() } = {}) {
  const [limits, used] = await Promise.all([
    getLimits(pool, tenantId),
    eventsToday(pool, tenantId, { day }),
  ]);
  const limit = limits.limit_events_day;
  const projected = used + addEvents;
  if (projected > limit) {
    return { allowed: false, warn: false, reason: 'events_day', used, projected, limit };
  }
  const c = classify(projected, limit);
  return { allowed: true, warn: c.warn, used, projected, limit };
}

/** Pre-flight for adding a seat. @returns {{allowed, warn, reason?, used, limit}} */
export async function checkSeatQuota(pool, tenantId, principal) {
  const [limits, exists] = await Promise.all([
    getLimits(pool, tenantId),
    pool.query(`SELECT 1 FROM tenant_seats WHERE tenant_id=$1 AND principal=$2`, [tenantId, principal]),
  ]);
  if (exists.rows.length) {
    // Already a seat — never rejected, never grows the count.
    const used = await seatCount(pool, tenantId);
    return { allowed: true, warn: false, used, limit: limits.limit_seats };
  }
  const used = await seatCount(pool, tenantId);
  const limit = limits.limit_seats;
  if (used + 1 > limit) return { allowed: false, warn: false, reason: 'seats', used, limit };
  const c = classify(used + 1, limit);
  return { allowed: true, warn: c.warn, used, limit };
}

/* ------------------------------------------------------------------ *
 * Util
 * ------------------------------------------------------------------ */

/** UTC calendar day as YYYY-MM-DD (matches the date column). */
export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
