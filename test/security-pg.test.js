import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { getPool, pgUrl } from '../src/pg/pool.js';
import { upsertAccount, setMembership, changeRoleGuarded, removeMemberGuarded } from '../src/auth_hosted/membership.js';
import { mintAccessToken } from '../src/auth_hosted/sessions.js';

/**
 * Regression tests for the security-audit fixes that need Postgres (cross-tenant
 * IDOR / impersonation / last-owner). Skip-if-no-DB (run: docker compose up -d).
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';
process.env.SCOPE_JWT_SECRET = process.env.SCOPE_JWT_SECRET || 'scope-test-jwt-secret-9f3a7c1e2b8d4506';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

const uniq = (p) => `${p}_${Math.floor(performance.now() * 1000)}_${Math.round(performance.timeOrigin)}`;

async function startHostedHub() {
  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  try { ws.db.close(); } catch {}
  ws.db = scope.db;
  const server = await startServer({ workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false, cloud: true });
  return { server, base: `http://127.0.0.1:${server.address().port}`, pool: getPool(),
    async close() { await new Promise((r) => server.close(() => r())); scope.cleanup(); } };
}
const sess = (id) => mintAccessToken({ sub: id });
const post = (base, path, tok, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `scope_session=${tok}`, Origin: base }, body: JSON.stringify(body) });
const del = (base, path, tok) => fetch(`${base}${path}`, { method: 'DELETE', headers: { Cookie: `scope_session=${tok}`, Origin: base } });
const get = (base, path, tok) => fetch(`${base}${path}`, { headers: { Cookie: `scope_session=${tok}` } });

test('SCP-199: an account cannot revoke another account API key', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const B = await upsertAccount(hub.pool, { email: uniq('b') + '@t.test', provider: 'github', providerSub: uniq('b') });
    const keyA = await (await post(hub.base, '/auth/keys', sess(A), { name: 'ci' })).json();
    // B tries to revoke A's key by id → 404, and A's key still works.
    const bRevoke = await del(hub.base, `/auth/keys/${keyA.id}`, sess(B));
    assert.equal(bRevoke.status, 404, 'cross-account revoke is refused');
    const stillWorks = await fetch(`${hub.base}/api/meta`, { headers: { Authorization: `Bearer ${keyA.key}` } });
    assert.equal(stillWorks.status, 200, "A's key was not revoked by B");
    // A can revoke its own key.
    assert.equal((await del(hub.base, `/auth/keys/${keyA.id}`, sess(A))).status, 200);
  } finally { await hub.close(); }
});

test('SCP-200: alias listing is authorized on the path tenant, not a spoofed selector', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const B = await upsertAccount(hub.pool, { email: uniq('b') + '@t.test', provider: 'github', providerSub: uniq('b') });
    const pa = await (await post(hub.base, '/api/projects', sess(A), { name: 'Alpha' })).json();
    const pb = await (await post(hub.base, '/api/projects', sess(B), { name: 'Bravo' })).json();
    // B (owner of its own board) tries to read A's aliases, selector pointed at B.
    const leak = await get(hub.base, `/api/projects/${pa.tenantId}/aliases?project=${pb.tenantId}`, sess(B));
    assert.equal(leak.status, 404, "B cannot read A's alias map");
    // A (a member) can read its own.
    assert.equal((await get(hub.base, `/api/projects/${pa.tenantId}/aliases`, sess(A))).status, 200);
  } finally { await hub.close(); }
});

test('SCP-201: cannot claim an alias equal to another account id (impersonation)', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const B = await upsertAccount(hub.pool, { email: uniq('b') + '@t.test', provider: 'github', providerSub: uniq('b') });
    const pa = await (await post(hub.base, '/api/projects', sess(A), { name: 'Alpha' })).json();
    await setMembership(hub.pool, { tenantId: pa.tenantId, accountId: B, role: 'member' });
    // B tries to claim A's account id as its alias on the shared board → 409.
    const steal = await post(hub.base, `/api/projects/${pa.tenantId}/aliases`, sess(B), { alias: A });
    assert.equal(steal.status, 409, 'claiming another account id as an alias is refused');
    // A claiming a plain local name still works.
    assert.equal((await post(hub.base, `/api/projects/${pa.tenantId}/aliases`, sess(A), { alias: 'alice-laptop' })).status, 201);
  } finally { await hub.close(); }
});

test('SCP-210: the last owner cannot be demoted or removed', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const pa = await (await post(hub.base, '/api/projects', sess(A), { name: 'Alpha' })).json();
    // A is the sole owner — the guarded ops must refuse.
    await assert.rejects(() => changeRoleGuarded(hub.pool, { tenantId: pa.tenantId, accountId: A, role: 'viewer' }), (e) => e.code === 'LAST_OWNER');
    await assert.rejects(() => removeMemberGuarded(hub.pool, { tenantId: pa.tenantId, accountId: A }), (e) => e.code === 'LAST_OWNER');
    // With a second owner, demotion is allowed.
    const B = await upsertAccount(hub.pool, { email: uniq('b') + '@t.test', provider: 'github', providerSub: uniq('b') });
    await setMembership(hub.pool, { tenantId: pa.tenantId, accountId: B, role: 'owner' });
    await changeRoleGuarded(hub.pool, { tenantId: pa.tenantId, accountId: A, role: 'viewer' }); // now ok (B remains owner)
  } finally { await hub.close(); }
});
