/**
 * Accounts / projects / memberships & role checks (SCP-131).
 *
 * Per ADR 0003 §3: accounts join projects; a project IS a tenant (the sync /
 * sharing boundary). Roles are owner > member > viewer. Tenancy is ALWAYS
 * derived from the authenticated subject's membership here — never from a
 * client-supplied X-Scope-Workspace header (ADR 0003 §4). The `tenant_id`
 * column is the same string the event-log tables key on (src/pg/store.js).
 *
 * Tables are defined in ./schema.js (ensureAuthSchema). Role-rank logic lives
 * there too (ROLE_RANK) and is pure, so `roleSatisfies` unit-tests without PG.
 */
import { randomBytes } from 'node:crypto';
import { ROLES, ROLE_RANK } from './schema.js';

export { ROLES, ROLE_RANK };

function id(prefix) { return `${prefix}_${randomBytes(9).toString('hex')}`; }
function nowIso(now) { return new Date(Number.isFinite(now) ? now : Date.now()).toISOString(); }

/** Pure: does `have` satisfy a "≥ need" requirement? Unknown roles never pass. */
export function roleSatisfies(have, need) {
  const h = ROLE_RANK[have];
  const n = ROLE_RANK[need];
  if (!h || !n) return false;
  return h >= n;
}

/* ------------------------------- accounts ------------------------------- */

/**
 * Upsert a human account by (provider, provider_sub) or email. Returns the
 * account id (the JWT `sub`). Used by the OIDC callback (SCP-129).
 */
export async function upsertAccount(pool, { email, name = null, provider = null, providerSub = null, now } = {}) {
  if (!email) throw new Error('upsertAccount: email required');
  const ts = nowIso(now);
  // Prefer matching on the OIDC identity; fall back to email.
  let existing = null;
  if (provider && providerSub) {
    existing = (await pool.query(
      'SELECT id FROM accounts WHERE provider=$1 AND provider_sub=$2', [provider, providerSub]
    )).rows[0];
  }
  if (!existing) {
    existing = (await pool.query('SELECT id FROM accounts WHERE lower(email)=lower($1)', [email])).rows[0];
  }
  if (existing) {
    await pool.query(
      `UPDATE accounts SET name=COALESCE($2,name), provider=COALESCE($3,provider),
         provider_sub=COALESCE($4,provider_sub), updated_at=$5 WHERE id=$1`,
      [existing.id, name, provider, providerSub, ts]
    );
    return existing.id;
  }
  const aid = id('acct');
  await pool.query(
    `INSERT INTO accounts (id, email, name, provider, provider_sub, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [aid, email, name, provider, providerSub, ts]
  );
  return aid;
}

/* ------------------------------- projects ------------------------------- */

/**
 * Create a project (a tenant) and make the creator its owner, atomically.
 * @returns {Promise<{ tenantId: string }>}
 */
export async function createProject(pool, { name, ownerAccountId, tenantId, now } = {}) {
  if (!name) throw new Error('createProject: name required');
  if (!ownerAccountId) throw new Error('createProject: ownerAccountId required');
  const tid = tenantId || id('tnt');
  const ts = nowIso(now);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO projects (tenant_id, name, created_by, created_at) VALUES ($1,$2,$3,$4)`,
      [tid, name, ownerAccountId, ts]
    );
    await client.query(
      `INSERT INTO memberships (tenant_id, account_id, role, created_at) VALUES ($1,$2,'owner',$3)`,
      [tid, ownerAccountId, ts]
    );
    await client.query('COMMIT');
    return { tenantId: tid };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ----------------------------- memberships ------------------------------ */

/** Add or update a member's role on a project (invite/accept lands here). */
export async function setMembership(pool, { tenantId, accountId, role, now } = {}) {
  if (!ROLES.includes(role)) throw new Error(`invalid role ${JSON.stringify(role)}`);
  await pool.query(
    `INSERT INTO memberships (tenant_id, account_id, role, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, account_id) DO UPDATE SET role=EXCLUDED.role`,
    [tenantId, accountId, role, nowIso(now)]
  );
}

/** Remove a member from a project. Idempotent. */
export async function removeMembership(pool, { tenantId, accountId } = {}) {
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1 AND account_id=$2', [tenantId, accountId]);
}

/**
 * Atomically apply a member mutation that must preserve >=1 owner (SCP-210).
 * `mutate` is 'remove' or a target role. We lock the tenant's owner rows
 * FOR UPDATE so two concurrent demotions/removals serialize and can't both pass
 * a stale "count > 1" check — the prior non-transactional guard could orphan a
 * board (0 owners). Throws {code:'LAST_OWNER'} / {code:'NO_MEMBER'}.
 */
async function withOwnerGuard(pool, tenantId, accountId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owners = (await client.query(
      `SELECT account_id FROM memberships WHERE tenant_id=$1 AND role='owner' FOR UPDATE`, [tenantId]
    )).rows.map((r) => r.account_id);
    const cur = (await client.query(
      'SELECT role FROM memberships WHERE tenant_id=$1 AND account_id=$2', [tenantId, accountId]
    )).rows[0];
    const result = await fn(client, owners, cur);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function lastOwnerError() { const e = new Error('cannot drop the last owner'); e.code = 'LAST_OWNER'; return e; }
function noMemberError() { const e = new Error('no such member'); e.code = 'NO_MEMBER'; return e; }

/** Change a member's role, atomically refusing to demote the last owner. */
export async function changeRoleGuarded(pool, { tenantId, accountId, role, now } = {}) {
  if (!ROLES.includes(role)) throw new Error(`invalid role ${JSON.stringify(role)}`);
  return withOwnerGuard(pool, tenantId, accountId, async (client, owners, cur) => {
    if (!cur) throw noMemberError();
    if (cur.role === 'owner' && role !== 'owner' && owners.length <= 1) throw lastOwnerError();
    await client.query(
      `INSERT INTO memberships (tenant_id, account_id, role, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, account_id) DO UPDATE SET role=EXCLUDED.role`,
      [tenantId, accountId, role, nowIso(now)]
    );
  });
}

/** Remove a member, atomically refusing to remove the last owner. Idempotent. */
export async function removeMemberGuarded(pool, { tenantId, accountId } = {}) {
  return withOwnerGuard(pool, tenantId, accountId, async (client, owners, cur) => {
    if (cur && cur.role === 'owner' && owners.length <= 1) throw lastOwnerError();
    await client.query('DELETE FROM memberships WHERE tenant_id=$1 AND account_id=$2', [tenantId, accountId]);
  });
}

/** The account's role on the project, or null if not a member. */
export async function getRole(pool, tenantId, accountId) {
  const row = (await pool.query(
    'SELECT role FROM memberships WHERE tenant_id=$1 AND account_id=$2', [tenantId, accountId]
  )).rows[0];
  return row ? row.role : null;
}

/**
 * True iff `accountId` has at least `minRole` on `tenantId`. The single
 * authorization predicate the rest of the hosted relay calls (sync push needs
 * ≥member; reads need ≥viewer; admin ops need owner).
 */
export async function hasRole(pool, tenantId, accountId, minRole) {
  const role = await getRole(pool, tenantId, accountId);
  return roleSatisfies(role, minRole);
}

/* ---------------------------- actor aliases ------------------------------ */
/* SCP-184: per-project mapping of local event-actor names ("bri") onto hosted
 * account ids, so sync-push authz can accept a member's own local history. */

/** Claim (or reassign) an alias on a project. First-come within a tenant:
 * claiming an alias already mapped to ANOTHER account throws ALIAS_TAKEN
 * unless `force` (owner reassignment). Idempotent for the same account. */
export async function claimAlias(pool, { tenantId, alias, accountId, force = false, now } = {}) {
  if (!alias || !String(alias).trim()) throw new Error('alias required');
  const a = String(alias).trim();
  // Impersonation guard (SCP-201): an account id IS an implicitly-allowed actor
  // for its owner, so letting someone claim an alias equal to ANOTHER account's
  // id would let them push events attributed to that account. Refuse it (the
  // alias namespace is for local human names like "bri", not account ids).
  if (a !== accountId) {
    const other = (await pool.query('SELECT 1 FROM accounts WHERE id=$1', [a])).rows[0];
    if (other) {
      const err = new Error(`alias "${a}" collides with another account`);
      err.code = 'ALIAS_TAKEN';
      throw err;
    }
  }
  const existing = (await pool.query(
    'SELECT account_id FROM tenant_aliases WHERE tenant_id=$1 AND alias=$2', [tenantId, a]
  )).rows[0];
  if (existing && existing.account_id !== accountId && !force) {
    const err = new Error(`alias "${a}" is already claimed on this project`);
    err.code = 'ALIAS_TAKEN';
    throw err;
  }
  await pool.query(
    `INSERT INTO tenant_aliases (tenant_id, alias, account_id, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, alias) DO UPDATE SET account_id=EXCLUDED.account_id`,
    [tenantId, a, accountId, nowIso(now)]
  );
  return { tenantId, alias: a, accountId };
}

/** Remove an alias mapping. Idempotent. */
export async function removeAlias(pool, { tenantId, alias } = {}) {
  await pool.query('DELETE FROM tenant_aliases WHERE tenant_id=$1 AND alias=$2', [tenantId, alias]);
}

/** All alias mappings on a project (attribution map for the board). */
export async function listAliases(pool, tenantId) {
  return (await pool.query(
    'SELECT alias, account_id, created_at FROM tenant_aliases WHERE tenant_id=$1 ORDER BY alias',
    [tenantId]
  )).rows;
}

/** The set of actor strings `accountId` may push as on `tenantId`:
 * the account id itself plus every alias it holds there. */
export async function allowedActorsFor(pool, tenantId, accountId) {
  const rows = (await pool.query(
    'SELECT alias FROM tenant_aliases WHERE tenant_id=$1 AND account_id=$2',
    [tenantId, accountId]
  )).rows;
  return new Set([accountId, ...rows.map((r) => r.alias)]);
}

/** Projects the account belongs to, with role. Used to populate JWT claims.
 * Archived projects are excluded — they keep their data (soft delete,
 * SCP-192) but stop being selectable boards or session defaults. */
export async function listMemberships(pool, accountId) {
  return (await pool.query(
    `SELECT m.tenant_id, m.role, p.name
       FROM memberships m JOIN projects p ON p.tenant_id=m.tenant_id
      WHERE m.account_id=$1 AND p.archived_at IS NULL ORDER BY p.created_at`, [accountId]
  )).rows;
}
