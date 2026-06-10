import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { createTicket } from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import { ensureAuthSchema } from '../src/auth_hosted/schema.js';
import { upsertAccount, createProject } from '../src/auth_hosted/membership.js';
import { mintAccessToken } from '../src/auth_hosted/sessions.js';

/**
 * SCP-170/171/172 — END-TO-END hosted auth over HTTP against a real Postgres.
 * Covers the exact wiring in server.js that the unit tests can't: the cloud
 * credential gate (session JWT + API key), the /auth/keys issuance route, and
 * the /api/sync/push actor-authz gate. Skip-if-unreachable so CI without a DB
 * still passes the rest of the suite (run: docker compose up -d).
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

async function startCloudHubPG() {
  const pool = getPool();
  await ensureAuthSchema(pool);
  // Seed a human account + their project (the OIDC callback would do this).
  const accountId = await upsertAccount(pool, { email: `e2e+${Date.now()}@scope.test`, name: 'E2E', provider: 'github', providerSub: `e2e-${Date.now()}` });
  const { tenantId } = await createProject(pool, { name: 'E2E project', ownerAccountId: accountId });

  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  try { ws.db.close(); } catch {}
  ws.db = scope.db;
  const server = await startServer({
    workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false, cloud: true,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = mintAccessToken({ sub: accountId, tenant_id: tenantId, role: 'owner' });
  return {
    server, scope, accountId, tenantId, session, wsId: ws.id, base,
    async close() { await new Promise((r) => server.close(() => r())); scope.cleanup(); },
  };
}

test('cloud+PG: no credential is 401; a session JWT cookie is 200', { skip }, async () => {
  const hub = await startCloudHubPG();
  try {
    const anon = await fetch(`${hub.base}/api/meta`);
    assert.equal(anon.status, 401, 'no shared-token bypass — real identity required');

    const authed = await fetch(`${hub.base}/api/meta`, { headers: { Cookie: `scope_session=${hub.session}` } });
    assert.equal(authed.status, 200, 'a valid session JWT authenticates');
  } finally { await hub.close(); }
});

test('cloud+PG: a session can mint an API key, and that key authenticates', { skip }, async () => {
  const hub = await startCloudHubPG();
  try {
    const create = await fetch(`${hub.base}/auth/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `scope_session=${hub.session}` },
      body: JSON.stringify({ name: 'ci-laptop' }),
    });
    assert.equal(create.status, 201);
    const { key } = await create.json();
    assert.ok(key && key.startsWith('sk_'), 'returns a one-time plaintext key');

    // The freshly-minted key authenticates a fresh request (no session cookie).
    const withKey = await fetch(`${hub.base}/api/meta`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(withKey.status, 200, 'the API key authenticates on its own');

    const noKey = await fetch(`${hub.base}/api/meta`, { headers: { Authorization: 'Bearer sk_bogus.deadbeef' } });
    assert.equal(noKey.status, 401, 'a bogus key is rejected');
  } finally { await hub.close(); }
});

test('cloud+PG: /api/sync/push rejects events whose actor != authenticated principal', { skip }, async () => {
  const hub = await startCloudHubPG();
  try {
    // Build two real events in the workspace log: one attributed to the
    // authenticated account, one to someone else.
    createTicket(hub.scope.db, { type: 'story', title: 'mine', actor: hub.accountId });
    createTicket(hub.scope.db, { type: 'story', title: 'theirs', actor: 'someone-else' });
    const events = readAllEvents(eventsDir(hub.scope.scopeDir));
    const mine = events.find((e) => e.actor === hub.accountId);
    const theirs = events.find((e) => e.actor === 'someone-else');
    assert.ok(mine && theirs, 'have both fixture events');

    // Tenant-scoped push (SCP-186): the target is the session's project board,
    // not a server workspace id — the volume workspace is private plumbing now.
    const push = (evts) => fetch(`${hub.base}/api/sync/push?project=${hub.tenantId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hub.session}` },
      body: JSON.stringify({ events: evts }),
    });

    const bad = await push([theirs]);
    assert.equal(bad.status, 403, 'an event impersonating another principal is refused');
    assert.equal((await bad.json()).code, 'ACTOR_MISMATCH');

    const ok = await push([mine]);
    assert.equal(ok.status, 200, 'an event whose actor IS the principal is accepted');
  } finally { await hub.close(); }
});
