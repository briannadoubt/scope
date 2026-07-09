/**
 * Tenant board operations (SCP-186) — a project IS a board, stored tenant-scoped
 * in Postgres. This is the serving-side bridge between the hosted identity layer
 * (projects/memberships) and the canonical event store (src/pg/store.js): a
 * project's board is its tenant's event log + replayed cache, read via
 * snapshotState and written via uploadEvents (events built the same way the
 * local repo builds them, so the PG replay materializes them identically).
 */
import { makeEvent } from '../event-schema.js';
import { DEFAULT_COLUMNS, normalizeColumns, openColumns, terminalColumns } from '../columns.js';
import { uploadEvents, snapshotState } from '../pg/store.js';
import { createProject, listMemberships } from './membership.js';

/** Derive a short workspace key from a project name (e.g. "Hosted Scope" -> "HS").
 * The event schema requires 2-10 uppercase alnum chars, so single-word names
 * fall back to their leading letters ("Alpha" -> "ALPHA"). */
function deriveKey(name) {
  const letters = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '');
  const squashed = letters.replace(/\s/g, '');
  const initials = letters.split(/\s+/).filter(Boolean).map((w) => w[0]).join('');
  let key = (initials.length >= 2 ? initials : squashed).slice(0, 5);
  if (key.length < 2) key = (key + 'XX').slice(0, 2);
  return key || 'SCOPE';
}

/** The projects (boards) an account belongs to, with role + name. */
export async function listProjects(pool, accountId) {
  const rows = await listMemberships(pool, accountId);
  return rows.map((r) => ({ id: r.tenant_id, tenant_id: r.tenant_id, role: r.role, name: r.name }));
}

/**
 * The caller's boards shaped like the /api/workspaces payload the web app
 * already consumes ({id, key, name, …}) — id is the tenant id, so the app's
 * existing workspace switcher + X-Scope-Workspace threading selects boards
 * with zero client changes (SCP-186/191).
 */
export async function listProjectBoards(pool, accountId) {
  const rows = (await pool.query(
    `SELECT m.tenant_id, m.role, p.name AS project_name, w.key, w.name
       FROM memberships m
       JOIN projects p ON p.tenant_id = m.tenant_id
       LEFT JOIN workspace w ON w.tenant_id = m.tenant_id
      WHERE m.account_id = $1 AND p.archived_at IS NULL
      ORDER BY p.created_at`, [accountId]
  )).rows;
  return rows.map((r) => ({
    id: r.tenant_id,
    scope_dir: null,
    label: r.project_name,
    key: r.key ?? deriveKey(r.project_name),
    name: r.name ?? r.project_name,
    description: '',
    overview: '',
    role: r.role,
  }));
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
  const evt = makeEvent('workspace.init', { key: k, name, columns: DEFAULT_COLUMNS }, { actor: accountId });
  await uploadEvents(pool, tenantId, [evt]);
  return { tenantId, key: k, name };
}

/**
 * Rename a project (SCP-192): the projects row AND the board's workspace name
 * move together — the latter via a workspace.set event so the rename is part
 * of the board's canonical history like any other change.
 */
export async function renameProject(pool, tenantId, { accountId, name } = {}) {
  if (!name) throw new Error('renameProject: name required');
  await pool.query('UPDATE projects SET name=$2 WHERE tenant_id=$1', [tenantId, name]);
  const evt = makeEvent('workspace.set', { name }, { actor: accountId });
  await uploadEvents(pool, tenantId, [evt]);
  return { tenantId, name };
}

export async function updateProjectBoard(pool, tenantId, { accountId, name, columns } = {}) {
  const payload = {};
  if (name !== undefined) {
    if (!name) throw new Error('updateProjectBoard: name required');
    await pool.query('UPDATE projects SET name=$2 WHERE tenant_id=$1', [tenantId, name]);
    payload.name = name;
  }
  if (columns !== undefined) payload.columns = normalizeColumns(columns);
  if (Object.keys(payload).length) {
    const evt = makeEvent('workspace.set', payload, { actor: accountId });
    await uploadEvents(pool, tenantId, [evt]);
  }
  return { tenantId, ...payload };
}

/**
 * Archive a project (soft delete, SCP-192). The tenant's event log and cache
 * stay intact — the board just stops being listable/selectable. Idempotent.
 */
export async function archiveProject(pool, tenantId, { now } = {}) {
  await pool.query(
    'UPDATE projects SET archived_at=$2 WHERE tenant_id=$1 AND archived_at IS NULL',
    [tenantId, new Date(Number.isFinite(now) ? now : Date.now()).toISOString()]
  );
  return { tenantId, archived: true };
}

/**
 * Read a tenant's board as { columns, buckets } (the shape the web board view
 * consumes), from the replayed cache via snapshotState.
 */
export async function readBoard(pool, tenantId) {
  const { state } = await snapshotState(pool, tenantId);
  const workspaceColumns = state.workspace?.columns?.length ? state.workspace.columns : DEFAULT_COLUMNS;
  const columns = openColumns(workspaceColumns);
  const terminal = terminalColumns(workspaceColumns);
  const buckets = Object.fromEntries([...columns, ...terminal].map((c) => [c.id, []]));
  for (const t of state.tickets || []) {
    (buckets[t.status] || (buckets[t.status] = [])).push(t);
  }
  return { columns, terminal_columns: terminal, buckets, workspace: state.workspace };
}
