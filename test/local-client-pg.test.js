import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { createTicket } from '../src/repo.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import { upsertAccount } from '../src/auth_hosted/membership.js';
import { createProjectBoard } from '../src/auth_hosted/tenant-board.js';
import { mintAccessToken } from '../src/auth_hosted/sessions.js';
import { writeRemoteConfig, writeCredential } from '../src/remote-config.js';

/**
 * SCP-237 — a LOCAL (non-hosted) board bound to a hosted project acts as a full
 * client: meta.remote reflects the binding, the collaboration control-plane is
 * proxied to the hub, and the local board mirrors the project in realtime via the
 * RemoteSyncAgent. Skip-if-no-PG.
 */
process.env.SCOPE_PG_URL = process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';
process.env.SCOPE_JWT_SECRET = process.env.SCOPE_JWT_SECRET || 'scope-test-jwt-secret-9f3a7c1e2b8d4506';
let available = false;
try { const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 }); await c.connect(); await c.end(); available = true; } catch {}
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';
const uniq = (p) => `${p}_${Math.floor(performance.now() * 1000)}`;
const until = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

async function hostedHub() {
  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  try { ws.db.close(); } catch {}
  ws.db = scope.db;
  const server = await startServer({ workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false, cloud: true });
  return { server, scope, base: `http://127.0.0.1:${server.address().port}`, pool: getPool(),
    async close() { await new Promise((r) => server.close(() => r())); scope.cleanup(); } };
}

async function localHubBoundTo(base, tenantId, key) {
  const scope = createTempScope();
  writeRemoteConfig(scope.scopeDir, { url: base, project: tenantId }); // committed pointer
  writeCredential(base, key);                                          // machine-local key
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  // keep mgr's own db (the local board)
  const server = await startServer({ workspaces: mgr, scopeDir: scope.scopeDir, port: 0, silent: true, discoverable: false, tls: false, cloud: false });
  return { server, scope, db: ws.db, base: `http://127.0.0.1:${server.address().port}`,
    async close() { await new Promise((r) => server.close(() => r())); scope.cleanup(); } };
}

test('SCP-237: local board bound to a hub — meta.remote, proxied collab, realtime mirror', { skip }, async () => {
  const hub = await hostedHub();
  let local;
  try {
    // Owner signs in (seeded), gets an API key, owns a project board.
    const owner = await upsertAccount(hub.pool, { email: uniq('o') + '@t', provider: 'github', providerSub: uniq('o') });
    const ownerTok = mintAccessToken({ sub: owner });
    const pa = await createProjectBoard(hub.pool, { accountId: owner, name: 'Shared Roadmap' });
    const keyRes = await fetch(`${hub.base}/auth/keys`, { method: 'POST', headers: { Authorization: `Bearer ${ownerTok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'laptop' }) });
    const { key } = await keyRes.json();

    // Bind a LOCAL board to that project.
    local = await localHubBoundTo(hub.base, pa.tenantId, key);

    // 1) meta.remote reflects the binding (connected + role from the hub).
    const meta = await (await fetch(`${local.base}/api/meta`)).json();
    assert.equal(meta.remote?.connected, true, 'local meta reports connected');
    assert.equal(meta.remote?.project, pa.tenantId);
    assert.equal(meta.remote?.role, 'owner');

    // 2) Collaboration is PROXIED to the hub through the local server.
    const members = await (await fetch(`${local.base}/api/projects/${pa.tenantId}/members`)).json();
    assert.ok(members.some((m) => m.account_id === owner), 'members list proxied from the hub');
    const inv = await fetch(`${local.base}/api/projects/${pa.tenantId}/invites`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'member' }) });
    assert.equal(inv.status, 201, 'invite created via the local proxy');

    // 3) Realtime mirror: a change made on the HUB shows on the LOCAL board.
    await fetch(`${hub.base}/api/tickets?project=${pa.tenantId}`, { method: 'POST', headers: { Authorization: `Bearer ${ownerTok}`, 'Content-Type': 'application/json', 'X-Scope-By': owner }, body: JSON.stringify({ type: 'story', title: 'made on the hub' }) });
    const appeared = await until(async () => {
      const board = await (await fetch(`${local.base}/api/board`)).json();
      return Object.values(board.buckets || {}).flat().some((t) => t.title === 'made on the hub');
    }, 5000);
    assert.ok(appeared, "the hub's new ticket mirrored onto the local board in realtime");

    // 4) Disconnect / reconnect from the local control endpoints.
    await fetch(`${local.base}/api/remote/disconnect`, { method: 'POST' });
    const after = await (await fetch(`${local.base}/api/meta`)).json();
    assert.equal(after.remote, null, 'disconnect clears the binding');
    const re = await (await fetch(`${local.base}/api/remote/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: hub.base, project: pa.tenantId, key }) })).json();
    assert.equal(re.connected, true, 'reconnect re-binds');
  } finally {
    if (local) await local.close();
    await hub.close();
    await closePool();
  }
});

test('SCP-241/242: connect CREATES a project from the local workspace + gitignores the event log', { skip }, async () => {
  const hub = await hostedHub();
  let close = null;
  try {
    const owner = await upsertAccount(hub.pool, { email: uniq('o') + '@t', provider: 'github', providerSub: uniq('o') });
    const otok = mintAccessToken({ sub: owner });
    const key = (await (await fetch(`${hub.base}/auth/keys`, { method: 'POST', headers: { Authorization: `Bearer ${otok}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'laptop' }) })).json()).key;

    // A plain local workspace, NOT pre-bound, with one local ticket.
    const scope = createTempScope();
    createTicket(scope.db, { type: 'story', title: 'born local', actor: owner });
    const mgr = new WorkspaceManager(); mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
    const server = await startServer({ workspaces: mgr, scopeDir: scope.scopeDir, port: 0, silent: true, discoverable: false, tls: false, cloud: false });
    close = async () => { await new Promise((r) => server.close(() => r())); scope.cleanup(); };
    const base = `http://127.0.0.1:${server.address().port}`;

    // Connect by CREATING a new remote project from this repo, gitignoring events.
    const r = await (await fetch(`${base}/api/remote/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: hub.base, key, createName: 'Born From Local', gitignoreEvents: true }) })).json();
    assert.equal(r.connected, true);
    assert.ok(r.project, 'a new project was created on the hub');
    assert.equal(r.gitignored, true);
    assert.match(readFileSync(join(scope.scopeDir, '.gitignore'), 'utf8'), /events\//, 'event log is now gitignored');

    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.remote?.role, 'owner', 'creator owns the new project');

    // The local board pushes UP to the new hub project (born from the local repo).
    const appeared = await until(async () => {
      const board = await (await fetch(`${hub.base}/api/board?project=${r.project}`, { headers: { Authorization: `Bearer ${otok}` } })).json();
      return Object.values(board.buckets || {}).flat().some((t) => t.title === 'born local');
    }, 6000);
    assert.ok(appeared, 'the local ticket reached the newly-created hub project');
  } finally {
    if (close) await close();
    await hub.close();
    await closePool();
  }
});
