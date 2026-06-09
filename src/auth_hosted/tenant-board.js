/**
 * Tenant board operations (SCP-186) — a project IS a board, stored tenant-scoped
 * in Postgres. This is the serving-side bridge between the hosted identity layer
 * (projects/memberships) and the canonical event store (src/pg/store.js): a
 * project's board is its tenant's event log + replayed cache, read via
 * snapshotState and written via uploadEvents (events built the same way the
 * local repo builds them, so the PG replay materializes them identically).
 */
import { makeEvent } from '../event-schema.js';
import { SCHEMA_STATUSES } from '../repo.js';
import { uploadEvents, snapshotState } from '../pg/store.js';
import { createProject, listMemberships } from './membership.js';

/** Derive a short workspace key from a project name (e.g. "Hosted Scope" -> "HS"). */
function deriveKey(name) {
  const letters = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '');
  const initials = letters.split(/\s+/).filter(Boolean).map((w) => w[0]).join('');
  const key = (initials || letters.replace(/\s/g, '')).slice(0, 5);
  return key || 'SCOPE';
}

/** The projects (boards) an account belongs to, with role + name. */
export async function listProjects(pool, accountId) {
  const rows = await listMemberships(pool, accountId);
  return rows.map((r) => ({ id: r.tenant_id, tenant_id: r.tenant_id, role: r.role, name: r.name }));
}

/**
 * Create a project and seed its board: insert the project + owner membership,
 * then emit a workspace.init event so the tenant's board materializes.
 * @returns {Promise<{tenantId: string, key: string, name: string}>}
 */
export async function createProjectBoard(pool, { accountId, name, key } = {}) {
  if (!accountId) throw new Error('createProjectBoard: accountId required');
  if (!name) throw new Error('createProjectBoard: name required');
  const k = (key && String(key).toUpperCase()) || deriveKey(name);
  const { tenantId } = await createProject(pool, { name, ownerAccountId: accountId });
  const evt = makeEvent('workspace.init', { key: k, name }, { actor: accountId });
  await uploadEvents(pool, tenantId, [evt]);
  return { tenantId, key: k, name };
}

/**
 * Read a tenant's board as { columns, buckets } (the shape the web board view
 * consumes), from the replayed cache via snapshotState.
 */
export async function readBoard(pool, tenantId) {
  const { state } = await snapshotState(pool, tenantId);
  const buckets = Object.fromEntries(SCHEMA_STATUSES.map((s) => [s, []]));
  for (const t of state.tickets || []) {
    (buckets[t.status] || (buckets[t.status] = [])).push(t);
  }
  return { columns: SCHEMA_STATUSES, buckets, workspace: state.workspace };
}
