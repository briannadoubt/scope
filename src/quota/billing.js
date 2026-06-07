/**
 * SCP-160 — Stripe billing integration + plan-tier enforcement.
 *
 * UNVERIFIABLE in this environment: requires the `stripe` npm dependency (NOT
 * installed here per the hosted-Scope ground rules) and live Stripe secret +
 * webhook-signing keys. The code is written assuming `import Stripe from
 * 'stripe'`; the import is lazy so the rest of src/quota/ stays importable and
 * testable without the dep. Treat this module as integration-ready but
 * un-run-here — exercise it against Stripe test-mode keys before relying on it.
 *
 * FLOW:
 *   1. createCheckoutSession  — start a subscription Checkout for a tenant.
 *   2. createPortalSession    — let an existing customer manage/cancel.
 *   3. handleWebhook          — verify the signature, then on subscription
 *      lifecycle events resolve the plan/tier and UPSERT it (with the matching
 *      quota limits) onto tenant_plan. quota.js getLimits() reads that row.
 *
 * PRICING-AGNOSTIC (SCP-127 open question): the price-id -> plan mapping lives
 * in PLAN_CATALOG below. SCP-160 assumes per-project tiers, but the catalog is
 * just (priceId -> {plan, limits}); switching to per-seat or per-usage means
 * editing this table + the price ids, NOT the webhook or quota plumbing. Free
 * tier is the implicit default (no tenant_plan row => FREE_TIER in quota.js),
 * and a cancellation downgrades by DELETING the row.
 *
 * Stripe object <-> tenant linkage: we stash `tenant_id` in the Checkout
 * session's `client_reference_id` and on the subscription/customer `metadata`,
 * so the webhook can resolve which tenant a subscription belongs to.
 */

import { FREE_TIER } from './quota.js';

/**
 * Price-id -> resolved plan + quota limits. Replace the price ids with your
 * Stripe dashboard ids. The free tier is intentionally absent (it's the
 * no-subscription default).
 *
 * Keep these LIMITS in sync with the dimensions quota.js enforces.
 */
export const PLAN_CATALOG = {
  // 'price_xxx_pro': { plan: 'pro', limits: {...} }
  [process.env.STRIPE_PRICE_PRO || 'price_pro_placeholder']: {
    plan: 'pro',
    limits: {
      limit_events_day: 100_000,
      limit_projects: 10,
      limit_seats: 25,
      limit_storage_bytes: 5 * 1024 * 1024 * 1024, // 5 GiB
    },
  },
  [process.env.STRIPE_PRICE_TEAM || 'price_team_placeholder']: {
    plan: 'team',
    limits: {
      limit_events_day: 1_000_000,
      limit_projects: 100,
      limit_seats: 250,
      limit_storage_bytes: 50 * 1024 * 1024 * 1024, // 50 GiB
    },
  },
};

/** Lazily construct the Stripe client (so the dep isn't required to import this). */
let _stripe = null;
async function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  const { default: Stripe } = await import('stripe'); // dep: stripe (NOT installed here)
  _stripe = new Stripe(key, { apiVersion: '2024-06-20' });
  return _stripe;
}

/** Override the Stripe client (tests / mocks). */
export function _setStripe(client) { _stripe = client; }

/**
 * Resolve a Stripe price id to a plan + limits, or null if unknown.
 * Exported so it's unit-testable without Stripe.
 */
export function planForPrice(priceId) {
  return PLAN_CATALOG[priceId] ?? null;
}

/* ------------------------------------------------------------------ *
 * Checkout + Portal
 * ------------------------------------------------------------------ */

/**
 * Start a subscription Checkout session for a tenant.
 * @returns {Promise<{url: string, id: string}>}
 */
export async function createCheckoutSession({ tenantId, priceId, successUrl, cancelUrl, customerId = null }) {
  if (!tenantId) throw new Error('createCheckoutSession: tenantId required');
  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: tenantId,           // primary tenant linkage
    customer: customerId || undefined,
    subscription_data: { metadata: { tenant_id: tenantId } },
    metadata: { tenant_id: tenantId },
  });
  return { url: session.url, id: session.id };
}

/**
 * Open the Stripe Customer Portal for an existing customer (manage/cancel).
 * @returns {Promise<{url: string}>}
 */
export async function createPortalSession({ customerId, returnUrl }) {
  if (!customerId) throw new Error('createPortalSession: customerId required');
  const stripe = await getStripe();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });
  return { url: session.url };
}

/* ------------------------------------------------------------------ *
 * Plan persistence
 * ------------------------------------------------------------------ */

/**
 * UPSERT the resolved plan + limits onto tenant_plan. This is the row
 * quota.js getLimits() reads. Pure DB write — exported for tests + webhook.
 */
export async function applyPlan(pool, tenantId, { plan, limits, stripeCustomerId = null, stripeSubscriptionId = null }) {
  await pool.query(
    `INSERT INTO tenant_plan
       (tenant_id, plan, limit_events_day, limit_projects, limit_seats,
        limit_storage_bytes, stripe_customer_id, stripe_subscription_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan=EXCLUDED.plan,
       limit_events_day=EXCLUDED.limit_events_day,
       limit_projects=EXCLUDED.limit_projects,
       limit_seats=EXCLUDED.limit_seats,
       limit_storage_bytes=EXCLUDED.limit_storage_bytes,
       stripe_customer_id=COALESCE(EXCLUDED.stripe_customer_id, tenant_plan.stripe_customer_id),
       stripe_subscription_id=COALESCE(EXCLUDED.stripe_subscription_id, tenant_plan.stripe_subscription_id),
       updated_at=now()`,
    [
      tenantId, plan, limits.limit_events_day, limits.limit_projects,
      limits.limit_seats, limits.limit_storage_bytes,
      stripeCustomerId, stripeSubscriptionId,
    ]
  );
}

/**
 * Downgrade a tenant to free by removing its plan row (getLimits falls back to
 * FREE_TIER). Used on subscription cancellation/expiry.
 */
export async function downgradeToFree(pool, tenantId) {
  await pool.query('DELETE FROM tenant_plan WHERE tenant_id=$1', [tenantId]);
}

/* ------------------------------------------------------------------ *
 * Webhook
 * ------------------------------------------------------------------ */

/**
 * Verify + handle a Stripe webhook. Mount on a RAW-body route (Stripe signature
 * verification needs the unparsed bytes — see INTEGRATION INSTRUCTIONS).
 *
 * @param {object} args
 * @param {import('pg').Pool} args.pool
 * @param {Buffer|string} args.rawBody - raw request body
 * @param {string} args.signature      - the 'stripe-signature' header
 * @returns {Promise<{handled: boolean, type: string, tenantId?: string}>}
 */
export async function handleWebhook({ pool, rawBody, signature }) {
  const stripe = await getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');

  // Throws on a bad signature — caller returns 400.
  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);

  switch (event.type) {
    case 'checkout.session.completed': {
      const s = event.data.object;
      const tenantId = s.client_reference_id || s.metadata?.tenant_id;
      // Resolve the subscription's price -> plan.
      const sub = await stripe.subscriptions.retrieve(s.subscription);
      await persistFromSubscription(pool, tenantId, sub);
      return { handled: true, type: event.type, tenantId };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const tenantId = sub.metadata?.tenant_id;
      if (sub.status === 'active' || sub.status === 'trialing') {
        await persistFromSubscription(pool, tenantId, sub);
      } else if (sub.status === 'canceled' || sub.status === 'unpaid' || sub.status === 'incomplete_expired') {
        if (tenantId) await downgradeToFree(pool, tenantId);
      }
      return { handled: true, type: event.type, tenantId };
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const tenantId = sub.metadata?.tenant_id;
      if (tenantId) await downgradeToFree(pool, tenantId);
      return { handled: true, type: event.type, tenantId };
    }
    default:
      return { handled: false, type: event.type };
  }
}

/** Resolve a subscription's first line-item price to a plan and persist it. */
async function persistFromSubscription(pool, tenantId, sub) {
  if (!tenantId) throw new Error('webhook: cannot resolve tenant_id from subscription');
  const priceId = sub.items?.data?.[0]?.price?.id;
  const resolved = planForPrice(priceId);
  if (!resolved) {
    // Unknown price -> safest is free-tier defaults rather than guessing.
    await applyPlan(pool, tenantId, {
      plan: FREE_TIER.plan,
      limits: FREE_TIER,
      stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
      stripeSubscriptionId: sub.id,
    });
    return;
  }
  await applyPlan(pool, tenantId, {
    plan: resolved.plan,
    limits: resolved.limits,
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
    stripeSubscriptionId: sub.id,
  });
}
