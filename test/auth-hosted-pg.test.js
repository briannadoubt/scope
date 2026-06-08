import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import { ensureAuthSchema } from '../src/auth_hosted/schema.js';
import {
  upsertAccount, createProject, setMembership, removeMembership,
  getRole, hasRole, listMemberships,
} from '../src/auth_hosted/membership.js';
import { createApiKey, authenticateApiKey, revokeApiKey, listApiKeys } from '../src/auth_hosted/apikeys.js';
import {
  issueRefreshToken, storeRefreshToken, rotateRefreshToken, revokeRefreshToken,
} from '../src/auth_hosted/sessions.js';

/**
 * SCP-130/131/129 — hosted-auth tables against Postgres. Skip-if-unreachable so
 * CI without a DB still passes the unit suite. Tenant/account ids are prefixed
 * "auth_" so this file never collides with the event-store tests on the shared
 * scope_test DB.
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

const T = 'auth_tnt_main';

test('SCP-131: account/project/membership + hasRole', { skip }, async () => {
  const pool = getPool();
  await ensureAuthSchema(pool);
  // clean slate for this tenant
  await pool.query('DELETE FROM memberships WHERE tenant_id=$1', [T]);
  await pool.query('DELETE FROM projects WHERE tenant_id=$1', [T]);

  const owner = await upsertAccount(pool, { email: 'auth_owner@x.com', name: 'Owner' });
  const member = await upsertAccount(pool, { email: 'auth_member@x.com', name: 'Member' });
  const stranger = await upsertAccount(pool, { email: 'auth_stranger@x.com' });

  // upsert is idempotent on email
  assert.equal(await upsertAccount(pool, { email: 'auth_owner@x.com' }), owner);

  await createProject(pool, { name: 'Hosted', ownerAccountId: owner, tenantId: T });
  await setMembership(pool, { tenantId: T, accountId: member, role: 'viewer' });

  assert.equal(await getRole(pool, T, owner), 'owner');
  assert.equal(await getRole(pool, T, member), 'viewer');
  assert.equal(await getRole(pool, T, stranger), null);

  // ≥member write gate (what SCP-132's role check uses)
  assert.equal(await hasRole(pool, T, owner, 'member'), true);
  assert.equal(await hasRole(pool, T, member, 'member'), false);   // viewer < member
  assert.equal(await hasRole(pool, T, member, 'viewer'), true);
  assert.equal(await hasRole(pool, T, stranger, 'viewer'), false); // not a member

  // promote, then a write gate passes
  await setMembership(pool, { tenantId: T, accountId: member, role: 'member' });
  assert.equal(await hasRole(pool, T, member, 'member'), true);

  const mine = await listMemberships(pool, owner);
  assert.ok(mine.some((m) => m.tenant_id === T && m.role === 'owner'));

  await removeMembership(pool, { tenantId: T, accountId: member });
  assert.equal(await getRole(pool, T, member), null);
});

test('SCP-130: api key generate->store->authenticate, plaintext not stored, revoke', { skip }, async () => {
  const pool = getPool();
  await ensureAuthSchema(pool);
  const acct = await upsertAccount(pool, { email: 'auth_keyowner@x.com' });
  await pool.query('DELETE FROM api_keys WHERE account_id=$1', [acct]);

  const { plaintext, id } = await createApiKey(pool, { accountId: acct, name: 'ci' });
  assert.match(plaintext, /^sk_/);

  // Plaintext is NOT stored anywhere — only the hash.
  const stored = (await pool.query('SELECT key_hash FROM api_keys WHERE id=$1', [id])).rows[0];
  const secret = plaintext.split('.')[1];
  assert.ok(!stored.key_hash.includes(secret), 'secret not in stored hash');
  const anyPlain = await pool.query('SELECT count(*)::int c FROM api_keys WHERE key_hash=$1', [plaintext]);
  assert.equal(anyPlain.rows[0].c, 0, 'plaintext is never a stored value');

  const principal = await authenticateApiKey(pool, plaintext);
  assert.equal(principal.accountId, acct);
  assert.equal(principal.keyId, id);

  // wrong key fails
  assert.equal(await authenticateApiKey(pool, 'sk_' + id + '.deadbeef'), null);

  // revoke -> auth fails
  await revokeApiKey(pool, id);
  assert.equal(await authenticateApiKey(pool, plaintext), null);

  const keys = await listApiKeys(pool, acct);
  assert.ok(keys.every((k) => !('key_hash' in k)), 'list never leaks hashes');
});

test('SCP-129: refresh-token rotation chains; reuse revokes the chain', { skip }, async () => {
  const pool = getPool();
  await ensureAuthSchema(pool);
  const acct = await upsertAccount(pool, { email: 'auth_session@x.com' });
  await pool.query('DELETE FROM refresh_tokens WHERE account_id=$1', [acct]);

  const { token, row } = issueRefreshToken(acct);
  await storeRefreshToken(pool, row);

  // rotate -> new token, old one now points at successor
  const rotated = await rotateRefreshToken(pool, token);
  assert.equal(rotated.accountId, acct);
  assert.notEqual(rotated.token, token);

  // presenting the OLD token again is reuse -> throws + revokes the chain
  await assert.rejects(() => rotateRefreshToken(pool, token), /reuse/);
  const live = (await pool.query(
    'SELECT count(*)::int c FROM refresh_tokens WHERE account_id=$1 AND revoked_at IS NULL', [acct]
  )).rows[0].c;
  assert.equal(live, 0, 'reuse detection revoked every live token');

  // logout revokes a token
  const { token: t2, row: r2 } = issueRefreshToken(acct);
  await storeRefreshToken(pool, r2);
  await revokeRefreshToken(pool, t2);
  await assert.rejects(() => rotateRefreshToken(pool, t2), /revoked/);
});

test.after(async () => { if (available) await closePool(); });
