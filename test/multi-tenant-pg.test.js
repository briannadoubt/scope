import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { createTicket } from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import { upsertAccount, setMembership } from '../src/auth_hosted/membership.js';
import { mintAccessToken } from '../src/auth_hosted/sessions.js';

/**
 * SCP-186/187/188 — multi-tenant FOUNDATION end-to-end against real Postgres.
 * Proves a project IS an isolated board: tenancy comes from the authenticated
 * subject (not a header), members are role-gated, and two tenants' data never
 * cross. Skip-if-no-DB (run: docker compose up -d).
 */
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';
process.env.SCOPE_JWT_SECRET = process.env.SCOPE_JWT_SECRET || 'mt-test-jwt-secret-0123456789';

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
  const server = await startServer({
    workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false, cloud: true,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, scope, base, pool: getPool(),
    async close() { await new Promise((r) => server.close(() => r())); scope.cleanup(); } };
}

// A session JWT for an account (tenant chosen per-request via ?project=).
const sess = (accountId) => mintAccessToken({ sub: accountId });
const authGet = (base, path, token) => fetch(`${base}${path}`, { headers: { Cookie: `scope_session=${token}` } });
const authPost = (base, path, token, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `scope_session=${token}` },
  body: JSON.stringify(body),
});

// Build a real ticket-create event attributed to `actor` (via the local repo).
function ticketEvent(actor, title) {
  const s = createTempScope();
  try {
    createTicket(s.db, { type: 'story', title, actor });
    return readAllEvents(eventsDir(s.scopeDir)).filter((e) => e.actor === actor);
  } finally { s.cleanup(); }
}

test('foundation: projects are per-account; cross-tenant read is denied', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const B = await upsertAccount(hub.pool, { email: uniq('b') + '@t.test', provider: 'github', providerSub: uniq('b') });
    const tokA = sess(A), tokB = sess(B);

    const pa = await (await authPost(hub.base, '/api/projects', tokA, { name: 'Alpha' })).json();
    const pb = await (await authPost(hub.base, '/api/projects', tokB, { name: 'Bravo' })).json();
    assert.ok(pa.tenantId && pb.tenantId && pa.tenantId !== pb.tenantId);

    const aProjects = await (await authGet(hub.base, '/api/projects', tokA)).json();
    assert.deepEqual(aProjects.map((p) => p.tenant_id), [pa.tenantId], 'A sees only its own board');

    // A is not a member of B's board → 404 (don't even disclose existence).
    const cross = await authGet(hub.base, `/api/board?project=${pb.tenantId}`, tokA);
    assert.equal(cross.status, 404, 'cross-tenant board read denied');
  } finally { await hub.close(); }
});

test('foundation: sync push/pull is tenant-scoped and isolated', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const B = await upsertAccount(hub.pool, { email: uniq('b') + '@t.test', provider: 'github', providerSub: uniq('b') });
    const tokA = sess(A), tokB = sess(B);
    const pa = await (await authPost(hub.base, '/api/projects', tokA, { name: 'Alpha' })).json();
    const pb = await (await authPost(hub.base, '/api/projects', tokB, { name: 'Bravo' })).json();

    // A pushes a ticket to its board.
    const evts = ticketEvent(A, 'A-only ticket');
    const push = await authPost(hub.base, `/api/sync/push?project=${pa.tenantId}`, tokA, { events: evts });
    assert.equal(push.status, 200);
    assert.equal((await push.json()).accepted.length, evts.length);

    // It shows on A's board…
    const aBoard = await (await authGet(hub.base, `/api/board?project=${pa.tenantId}`, tokA)).json();
    const aTitles = Object.values(aBoard.buckets).flat().map((t) => t.title);
    assert.ok(aTitles.includes('A-only ticket'), 'A board has the ticket');

    // …and NOT on B's board (isolation). B's board has only its own seed event;
    // none of A's pushed events leak across the tenant boundary.
    const aIds = new Set(evts.map((e) => e.id));
    const bPull = await (await authGet(hub.base, `/api/sync/pull?project=${pb.tenantId}`, tokB)).json();
    assert.ok(!bPull.events.some((e) => aIds.has(e.id)), 'none of A events appear on B board');
    const bTitles = bPull.events.flatMap((e) => e.payload?.title ? [e.payload.title] : []);
    assert.ok(!bTitles.includes('A-only ticket'), 'B board is isolated from A');
  } finally { await hub.close(); }
});

test('foundation: role gate — viewer reads, only member writes', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const C = await upsertAccount(hub.pool, { email: uniq('c') + '@t.test', provider: 'github', providerSub: uniq('c') });
    const tokA = sess(A), tokC = sess(C);
    const pa = await (await authPost(hub.base, '/api/projects', tokA, { name: 'Alpha' })).json();

    // C is added as a viewer of A's board.
    await setMembership(hub.pool, { tenantId: pa.tenantId, accountId: C, role: 'viewer' });

    const read = await authGet(hub.base, `/api/board?project=${pa.tenantId}`, tokC);
    assert.equal(read.status, 200, 'viewer can read');

    const write = await authPost(hub.base, `/api/sync/push?project=${pa.tenantId}`, tokC, { events: ticketEvent(C, 'nope') });
    assert.equal(write.status, 403, 'viewer cannot write');
    assert.equal((await write.json()).code, 'FORBIDDEN_ROLE');
  } finally { await hub.close(); }
});

test('foundation: actor authz — cannot push events attributed to another principal', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const B = await upsertAccount(hub.pool, { email: uniq('b') + '@t.test', provider: 'github', providerSub: uniq('b') });
    const tokA = sess(A);
    const pa = await (await authPost(hub.base, '/api/projects', tokA, { name: 'Alpha' })).json();

    // A is a member of its board but pushes events whose actor is B.
    const forged = ticketEvent(B, 'forged');
    const res = await authPost(hub.base, `/api/sync/push?project=${pa.tenantId}`, tokA, { events: forged });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'ACTOR_MISMATCH');
  } finally { await hub.close(); }
});
