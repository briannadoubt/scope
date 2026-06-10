import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { createTicket } from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { syncWithRemote } from '../src/sync-client.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import { upsertAccount } from '../src/auth_hosted/membership.js';
import { mintAccessToken } from '../src/auth_hosted/sessions.js';

/**
 * SCP-227..231 — UX hardening: invite cold-path, no-landing-when-signed-in,
 * frictionless bind (alias auto-claim), authz only on new events. Skip-if-no-PG.
 */
process.env.SCOPE_PG_URL = process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';
process.env.SCOPE_JWT_SECRET = process.env.SCOPE_JWT_SECRET || 'scope-test-jwt-secret-9f3a7c1e2b8d4506';

let available = false;
try { const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 }); await c.connect(); await c.end(); available = true; } catch {}
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';
const uniq = (p) => `${p}_${Math.floor(performance.now() * 1000)}`;

async function hub() {
  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  try { ws.db.close(); } catch {}
  ws.db = scope.db;
  const server = await startServer({ workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false, cloud: true });
  return { server, scope, base: `http://127.0.0.1:${server.address().port}`, pool: getPool(),
    async close() { await new Promise((r) => server.close(() => r())); scope.cleanup(); } };
}
const sess = (id) => mintAccessToken({ sub: id });
const J = (tok) => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });

test('SCP-228: public /invite/<code> — logged-out gets a join page; signed-in joins + redirects', { skip }, async () => {
  const h = await hub();
  try {
    const alice = await upsertAccount(h.pool, { email: uniq('a') + '@t', provider: 'github', providerSub: uniq('a') });
    const bob = await upsertAccount(h.pool, { email: uniq('b') + '@t', provider: 'github', providerSub: uniq('b') });
    const pa = await (await fetch(`${h.base}/api/projects`, { method: 'POST', headers: J(sess(alice)), body: JSON.stringify({ name: 'Cold Path' }) })).json();
    const inv = await (await fetch(`${h.base}/api/projects/${pa.tenantId}/invites`, { method: 'POST', headers: J(sess(alice)), body: JSON.stringify({ role: 'member' }) })).json();

    // Logged-OUT visitor: a friendly join page (NOT a 401).
    const out = await fetch(`${h.base}/invite/${inv.code}`, { redirect: 'manual' });
    assert.equal(out.status, 200);
    const html = await out.text();
    assert.match(html, /invited to Cold Path/i);
    assert.match(html, /Sign in with GitHub to join/i);

    // Signed-IN visitor: joins immediately + 302 to the app.
    const inWith = await fetch(`${h.base}/invite/${inv.code}`, { headers: { Cookie: `scope_session=${sess(bob)}` }, redirect: 'manual' });
    assert.equal(inWith.status, 302);
    assert.equal(inWith.headers.get('location'), '/app');
    const bobProjects = await (await fetch(`${h.base}/api/projects`, { headers: J(sess(bob)) })).json();
    assert.ok(bobProjects.some((p) => p.tenant_id === pa.tenantId), 'Bob is now a member');

    // A bogus code → a friendly invalid page, never a crash.
    const bad = await fetch(`${h.base}/invite/totallyfake`, { redirect: 'manual' });
    assert.ok(bad.status === 410 || bad.status === 404);
  } finally { await h.close(); }
});

test('SCP-231: signed-in visitor to / is redirected to /app; logged-out sees the landing', { skip }, async () => {
  const h = await hub();
  try {
    const a = await upsertAccount(h.pool, { email: uniq('a') + '@t', provider: 'github', providerSub: uniq('a') });
    const signedIn = await fetch(`${h.base}/`, { headers: { Cookie: `scope_session=${sess(a)}` }, redirect: 'manual' });
    assert.equal(signedIn.status, 302);
    assert.equal(signedIn.headers.get('location'), '/app');

    const anon = await fetch(`${h.base}/`, { redirect: 'manual' });
    assert.equal(anon.status, 200, 'logged-out sees the public landing');
  } finally { await h.close(); }
});

test('SCP-230: sync auto-claims the local actor alias and succeeds (no manual step)', { skip }, async () => {
  const h = await hub();
  try {
    const alice = await upsertAccount(h.pool, { email: uniq('a') + '@t', provider: 'github', providerSub: uniq('a') });
    const pa = await (await fetch(`${h.base}/api/projects`, { method: 'POST', headers: J(sess(alice)), body: JSON.stringify({ name: 'Bind Test' }) })).json();

    // A local repo whose events are stamped with a human name, not the account id.
    const local = createTempScope();
    createTicket(local.db, { type: 'story', title: 'from my laptop', actor: 'localdev' });

    const r = await syncWithRemote(local.db, local.scopeDir, { remote: h.base, remoteWorkspace: pa.tenantId, token: sess(alice) });
    assert.ok(r.pushed >= 1, 'push succeeded after auto-claiming the alias');

    const aliases = await (await fetch(`${h.base}/api/projects/${pa.tenantId}/aliases`, { headers: J(sess(alice)) })).json();
    assert.ok(aliases.some((x) => x.alias === 'localdev'), 'the local actor was claimed as an alias');
    local.cleanup();
  } finally { await h.close(); }
});

test('SCP-230: push actor-authz applies only to NEW events (teammate dups in the batch are fine)', { skip }, async () => {
  const h = await hub();
  try {
    const alice = await upsertAccount(h.pool, { email: uniq('a') + '@t', provider: 'github', providerSub: uniq('a') });
    const bob = await upsertAccount(h.pool, { email: uniq('b') + '@t', provider: 'github', providerSub: uniq('b') });
    const pa = await (await fetch(`${h.base}/api/projects`, { method: 'POST', headers: J(sess(alice)), body: JSON.stringify({ name: 'Mixed Batch' }) })).json();
    // Bob is a member.
    const inv = await (await fetch(`${h.base}/api/projects/${pa.tenantId}/invites`, { method: 'POST', headers: J(sess(alice)), body: JSON.stringify({ role: 'member' }) })).json();
    await fetch(`${h.base}/api/invites/accept`, { method: 'POST', headers: J(sess(bob)), body: JSON.stringify({ code: inv.code }) });

    // Build one event authored by Alice, one by Bob (via temp logs).
    const sa = createTempScope(); createTicket(sa.db, { type: 'story', title: 'alice item', actor: alice });
    const aliceEvt = readAllEvents(eventsDir(sa.scopeDir)).find((e) => e.actor === alice);
    const sb = createTempScope(); createTicket(sb.db, { type: 'story', title: 'bob item', actor: bob });
    const bobEvt = readAllEvents(eventsDir(sb.scopeDir)).find((e) => e.actor === bob);

    // Alice pushes hers → it's now on the board.
    await fetch(`${h.base}/api/sync/push?project=${pa.tenantId}`, { method: 'POST', headers: J(sess(alice)), body: JSON.stringify({ events: [aliceEvt] }) });
    // Bob pushes a batch with Alice's (now-duplicate) event + his own NEW one.
    const mixed = await fetch(`${h.base}/api/sync/push?project=${pa.tenantId}`, { method: 'POST', headers: J(sess(bob)), body: JSON.stringify({ events: [aliceEvt, bobEvt] }) });
    assert.equal(mixed.status, 200, 'a dup teammate event in the batch no longer trips actor-authz');
    const body = await mixed.json();
    assert.ok(body.accepted.some((e) => e.id === bobEvt.id), "Bob's own new event was accepted");
    sa.cleanup(); sb.cleanup();
  } finally { await h.close(); }
});
