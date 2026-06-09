import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import express from 'express';

import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import { ensureAuthSchema } from '../src/auth_hosted/schema.js';
import { upsertAccount, createProject, setMembership, getRole } from '../src/auth_hosted/membership.js';
import { membersRouter } from '../src/auth_hosted/invites.js';

/**
 * SCP-190 — invite flow + member management against real Postgres. The server
 * wiring (server.js) lands with the integrator, so this exercises the router on
 * a bare express app behind a stub credential gate that sets req.principal from
 * an X-Test-Account header — exactly the contract cloud-auth.js's
 * hostedAuthMiddleware provides. Skip-if-no-DB (run: docker compose up -d).
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';
process.env.SCOPE_JWT_SECRET = process.env.SCOPE_JWT_SECRET || 'inv-test-jwt-secret-0123456789';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

const uniq = (p) => `${p}_${Math.floor(performance.now() * 1000)}_${Math.round(performance.timeOrigin)}`;

// Bare app: json body parsing + stub credential gate (req.principal from a test
// header, mirroring cloud-auth.js) + the SCP-190 router under test.
async function startApp() {
  const pool = getPool();
  await ensureAuthSchema(pool);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const acct = req.headers['x-test-account'];
    if (!acct) return res.status(401).json({ error: 'unauthorized' });
    req.principal = { accountId: acct, kind: 'session', tenantId: null, role: null };
    next();
  });
  app.use(membersRouter({ pool }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { pool, base, async close() { await new Promise((r) => server.close(() => r())); } };
}

const asGet = (base, path, acct) => fetch(`${base}${path}`, { headers: { 'X-Test-Account': acct } });
const asSend = (method) => (base, path, acct, body) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', 'X-Test-Account': acct },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const asPost = asSend('POST');
const asPatch = asSend('PATCH');
const asDelete = asSend('DELETE');

// A fresh project with an owner (and optionally extra members), unique per run.
async function seedProject(pool, extra = []) {
  const owner = await upsertAccount(pool, { email: uniq('inv_owner') + '@t.test', name: 'Owner' });
  const { tenantId } = await createProject(pool, { name: 'Inviteland', ownerAccountId: owner, tenantId: uniq('inv_tnt') });
  const members = {};
  for (const role of extra) {
    const id = await upsertAccount(pool, { email: uniq(`inv_${role}`) + '@t.test', name: role });
    await setMembership(pool, { tenantId, accountId: id, role });
    members[role] = id;
  }
  return { owner, tenantId, members };
}

test('SCP-190: owner invites by email+role; non-owner/non-member are gated', { skip }, async () => {
  const app = await startApp();
  try {
    const { owner, tenantId, members } = await seedProject(app.pool, ['member']);
    const stranger = await upsertAccount(app.pool, { email: uniq('inv_str') + '@t.test' });

    // Owner mints an invite; the code comes back exactly once.
    const created = await asPost(app.base, `/api/projects/${tenantId}/invites`, owner, {
      email: 'friend@t.test', role: 'viewer',
    });
    assert.equal(created.status, 201);
    const inv = await created.json();
    assert.ok(inv.code && inv.code.length >= 20, 'unguessable code returned once');
    assert.equal(inv.email, 'friend@t.test');
    assert.equal(inv.role, 'viewer');
    assert.ok(inv.expires_at > new Date().toISOString(), 'expires in the future');

    // role defaults to member; bad role rejected.
    const dflt = await (await asPost(app.base, `/api/projects/${tenantId}/invites`, owner, {})).json();
    assert.equal(dflt.role, 'member');
    const bad = await asPost(app.base, `/api/projects/${tenantId}/invites`, owner, { role: 'admin' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'INVALID_ROLE');

    // The plaintext code is NEVER stored — only its hash.
    const stored = await app.pool.query('SELECT count(*)::int c FROM invites WHERE code_hash=$1', [inv.code]);
    assert.equal(stored.rows[0].c, 0, 'plaintext is never a stored value');

    // Pending list is owner-only and never leaks the code/hash.
    const list = await asGet(app.base, `/api/projects/${tenantId}/invites`, owner);
    assert.equal(list.status, 200);
    const pending = await list.json();
    assert.equal(pending.length, 2);
    for (const p of pending) {
      assert.ok(p.id && p.role && p.expires_at);
      assert.ok(!('code' in p) && !('code_hash' in p), 'list never leaks the code');
    }

    // A plain member can't invite or list invites (403); a stranger gets 404.
    const memberTry = await asPost(app.base, `/api/projects/${tenantId}/invites`, members.member, { email: 'x@t.test' });
    assert.equal(memberTry.status, 403);
    assert.equal((await memberTry.json()).code, 'FORBIDDEN_ROLE');
    assert.equal((await asGet(app.base, `/api/projects/${tenantId}/invites`, members.member)).status, 403);
    assert.equal((await asGet(app.base, `/api/projects/${tenantId}/invites`, stranger)).status, 404, 'non-member never learns the board exists');
  } finally { await app.close(); }
});

test('SCP-190: accept grants membership at the role and is single-use', { skip }, async () => {
  const app = await startApp();
  try {
    const { owner, tenantId } = await seedProject(app.pool);
    const joiner = await upsertAccount(app.pool, { email: uniq('inv_join') + '@t.test' });

    const inv = await (await asPost(app.base, `/api/projects/${tenantId}/invites`, owner, {
      email: 'addressee@t.test', role: 'member',
    })).json();

    // Accept: membership granted at the invite's role; project name returned so
    // the client can switch boards. Email differs from the addressee — accepted
    // anyway (the code is the credential) but flagged.
    const acc = await asPost(app.base, '/api/invites/accept', joiner, { code: inv.code });
    assert.equal(acc.status, 200);
    const body = await acc.json();
    assert.equal(body.tenantId, tenantId);
    assert.equal(body.role, 'member');
    assert.equal(body.name, 'Inviteland');
    assert.equal(body.email_mismatch, true, 'advisory mismatch flag');
    assert.equal(await getRole(app.pool, tenantId, joiner), 'member');

    // Single-use: a second accept (any account) fails.
    const again = await asPost(app.base, '/api/invites/accept', joiner, { code: inv.code });
    assert.equal(again.status, 400);
    assert.equal((await again.json()).code, 'INVITE_INVALID');

    // Garbage code fails the same way (no oracle).
    const junk = await asPost(app.base, '/api/invites/accept', joiner, { code: 'not-a-real-code' });
    assert.equal(junk.status, 400);
    assert.equal((await junk.json()).code, 'INVITE_INVALID');

    // Matching email → no mismatch flag.
    const matched = await upsertAccount(app.pool, { email: uniq('inv_match') + '@t.test' });
    const acctEmail = (await app.pool.query('SELECT email FROM accounts WHERE id=$1', [matched])).rows[0].email;
    const inv2 = await (await asPost(app.base, `/api/projects/${tenantId}/invites`, owner, {
      email: acctEmail.toUpperCase(), role: 'viewer',
    })).json();
    const acc2 = await (await asPost(app.base, '/api/invites/accept', matched, { code: inv2.code })).json();
    assert.equal(acc2.role, 'viewer');
    assert.ok(!acc2.email_mismatch, 'case-insensitive email match is not flagged');
  } finally { await app.close(); }
});

test('SCP-190: expired invites are rejected; revoke works and is idempotent', { skip }, async () => {
  const app = await startApp();
  try {
    const { owner, tenantId } = await seedProject(app.pool);
    const joiner = await upsertAccount(app.pool, { email: uniq('inv_late') + '@t.test' });

    // Expired: backdate the row, then accept → INVITE_EXPIRED, no membership.
    const expired = await (await asPost(app.base, `/api/projects/${tenantId}/invites`, owner, {})).json();
    await app.pool.query(
      'UPDATE invites SET expires_at=$2 WHERE tenant_id=$1', [tenantId, new Date(Date.now() - 1000).toISOString()]
    );
    const late = await asPost(app.base, '/api/invites/accept', joiner, { code: expired.code });
    assert.equal(late.status, 400);
    assert.equal((await late.json()).code, 'INVITE_EXPIRED');
    assert.equal(await getRole(app.pool, tenantId, joiner), null);
    // …and the expired invite no longer shows as pending.
    assert.deepEqual(await (await asGet(app.base, `/api/projects/${tenantId}/invites`, owner)).json(), []);

    // Revoke: pending invite disappears and its code stops working. Idempotent.
    const inv = await (await asPost(app.base, `/api/projects/${tenantId}/invites`, owner, {})).json();
    const [pending] = await (await asGet(app.base, `/api/projects/${tenantId}/invites`, owner)).json();
    assert.equal((await asDelete(app.base, `/api/projects/${tenantId}/invites/${pending.id}`, owner)).status, 200);
    assert.equal((await asDelete(app.base, `/api/projects/${tenantId}/invites/${pending.id}`, owner)).status, 200, 'revoke is idempotent');
    assert.deepEqual(await (await asGet(app.base, `/api/projects/${tenantId}/invites`, owner)).json(), []);
    const revoked = await asPost(app.base, '/api/invites/accept', joiner, { code: inv.code });
    assert.equal(revoked.status, 400);
    assert.equal((await revoked.json()).code, 'INVITE_INVALID');
  } finally { await app.close(); }
});

test('SCP-190: accept never downgrades an existing higher role', { skip }, async () => {
  const app = await startApp();
  try {
    const { owner, tenantId } = await seedProject(app.pool);
    // The owner accidentally redeems a viewer invite for their own board.
    const inv = await (await asPost(app.base, `/api/projects/${tenantId}/invites`, owner, { role: 'viewer' })).json();
    const acc = await (await asPost(app.base, '/api/invites/accept', owner, { code: inv.code })).json();
    assert.equal(acc.role, 'owner', 'kept the higher existing role');
    assert.equal(await getRole(app.pool, tenantId, owner), 'owner');
  } finally { await app.close(); }
});

test('SCP-190: members list / role change / remove, with role gates', { skip }, async () => {
  const app = await startApp();
  try {
    const { owner, tenantId, members } = await seedProject(app.pool, ['member', 'viewer']);
    const stranger = await upsertAccount(app.pool, { email: uniq('inv_str') + '@t.test' });

    // Any member (even a viewer) can list members; a stranger gets 404.
    const list = await asGet(app.base, `/api/projects/${tenantId}/members`, members.viewer);
    assert.equal(list.status, 200);
    const rows = await list.json();
    assert.equal(rows.length, 3);
    for (const m of rows) assert.ok(m.account_id && m.email && m.role && m.created_at);
    assert.equal(rows.find((m) => m.account_id === owner).role, 'owner');
    assert.equal((await asGet(app.base, `/api/projects/${tenantId}/members`, stranger)).status, 404);

    // Owner promotes the viewer; non-owner can't change roles; bad role 400.
    const promote = await asPatch(app.base, `/api/projects/${tenantId}/members/${members.viewer}`, owner, { role: 'member' });
    assert.equal(promote.status, 200);
    assert.equal(await getRole(app.pool, tenantId, members.viewer), 'member');
    const memberTry = await asPatch(app.base, `/api/projects/${tenantId}/members/${members.viewer}`, members.member, { role: 'owner' });
    assert.equal(memberTry.status, 403);
    assert.equal((await asPatch(app.base, `/api/projects/${tenantId}/members/${members.viewer}`, owner, { role: 'boss' })).status, 400);
    assert.equal((await asPatch(app.base, `/api/projects/${tenantId}/members/${stranger}`, owner, { role: 'member' })).status, 404, 'patching a non-member is 404');

    // Owner removes a member; a member can't remove someone ELSE.
    const denied = await asDelete(app.base, `/api/projects/${tenantId}/members/${members.viewer}`, members.member);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'FORBIDDEN_ROLE');
    assert.equal((await asDelete(app.base, `/api/projects/${tenantId}/members/${members.viewer}`, owner)).status, 200);
    assert.equal(await getRole(app.pool, tenantId, members.viewer), null);
  } finally { await app.close(); }
});

test('SCP-190: LAST_OWNER guard, and self-leave for non-owners', { skip }, async () => {
  const app = await startApp();
  try {
    const { owner, tenantId, members } = await seedProject(app.pool, ['member']);

    // Sole owner can neither demote nor remove themselves.
    const demote = await asPatch(app.base, `/api/projects/${tenantId}/members/${owner}`, owner, { role: 'member' });
    assert.equal(demote.status, 400);
    assert.equal((await demote.json()).code, 'LAST_OWNER');
    const leave = await asDelete(app.base, `/api/projects/${tenantId}/members/${owner}`, owner);
    assert.equal(leave.status, 400);
    assert.equal((await leave.json()).code, 'LAST_OWNER');
    assert.equal(await getRole(app.pool, tenantId, owner), 'owner', 'still the owner');

    // A non-owner member may leave on their own.
    assert.equal((await asDelete(app.base, `/api/projects/${tenantId}/members/${members.member}`, members.member)).status, 200);
    assert.equal(await getRole(app.pool, tenantId, members.member), null);

    // With a SECOND owner aboard, the first owner may step down and leave.
    const co = await upsertAccount(app.pool, { email: uniq('inv_co') + '@t.test' });
    await setMembership(app.pool, { tenantId, accountId: co, role: 'owner' });
    assert.equal((await asPatch(app.base, `/api/projects/${tenantId}/members/${owner}`, owner, { role: 'member' })).status, 200);
    assert.equal(await getRole(app.pool, tenantId, owner), 'member');
    assert.equal((await asDelete(app.base, `/api/projects/${tenantId}/members/${owner}`, owner)).status, 200);
    assert.equal(await getRole(app.pool, tenantId, owner), null);
    // …and now the co-owner is the last owner and protected again.
    const last = await asDelete(app.base, `/api/projects/${tenantId}/members/${co}`, co);
    assert.equal(last.status, 400);
    assert.equal((await last.json()).code, 'LAST_OWNER');
  } finally { await app.close(); }
});

test.after(async () => { if (available) await closePool(); });
