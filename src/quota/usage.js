/**
 * SCP-159 — surface quota + usage state to users.
 *
 * getUsage(pool, tenant) returns a summary of current usage vs plan limits for
 * every quota dimension, plus the soft-warning state, so humans and agents can
 * back off before hitting hard caps. Feeds a GET /api/usage route and/or an
 * extension to GET /api/meta (see INTEGRATION INSTRUCTIONS).
 *
 * Read-only: it never writes counters. Each dimension reuses quota.js's
 * `classify` so the warn/exceeded thresholds match enforcement exactly.
 *
 * Optionally folds in the LIVE SSE connection count from a ConnectionTracker
 * (SCP-158) when one is passed — that count is in-memory, not in PG.
 */

import {
  getLimits,
  eventsToday,
  seatCount,
  storageBytes,
  projectCount,
  classify,
  FREE_TIER,
} from './quota.js';

/**
 * @param {import('pg').Pool} pool
 * @param {string} tenant
 * @param {object} [opts]
 * @param {import('./connections.js').ConnectionTracker} [opts.connections]
 *   live SSE tracker; if given, a `connections` dimension is included.
 * @returns {Promise<{
 *   tenant: string,
 *   plan: string,
 *   warn: boolean,
 *   dimensions: Record<string, {used:number, limit:number, ratio:number, warn:boolean, exceeded:boolean}>
 * }>}
 */
export async function getUsage(pool, tenant, { connections } = {}) {
  const [limits, events, seats, storage, projects] = await Promise.all([
    getLimits(pool, tenant),
    eventsToday(pool, tenant),
    seatCount(pool, tenant),
    storageBytes(pool, tenant),
    projectCount(pool, tenant),
  ]);

  const dimensions = {
    events_day: classify(events, limits.limit_events_day),
    seats: classify(seats, limits.limit_seats),
    storage_bytes: classify(storage, limits.limit_storage_bytes),
    projects: classify(projects, limits.limit_projects),
  };

  // Live SSE connections are in-memory (SCP-158); only the count is known here.
  // There's no PG limit column for it — the ceiling lives on the tracker.
  if (connections) {
    dimensions.connections = classify(connections.count(tenant), connections.ceiling);
  }

  const warn = Object.values(dimensions).some((d) => d.warn || d.exceeded);

  return {
    tenant,
    plan: limits.plan ?? FREE_TIER.plan,
    warn,
    dimensions,
  };
}
