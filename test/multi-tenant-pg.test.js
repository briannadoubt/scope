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

test('replica REST: full ticket surface is tenant-scoped through the existing handlers', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const B = await upsertAccount(hub.pool, { email: uniq('b') + '@t.test', provider: 'github', providerSub: uniq('b') });
    const tokA = sess(A), tokB = sess(B);
    const pa = await (await authPost(hub.base, '/api/projects', tokA, { name: 'Alpha' })).json();
    const pb = await (await authPost(hub.base, '/api/projects', tokB, { name: 'Bravo' })).json();

    // A creates a ticket via the EXISTING REST handler (repo.js over the replica).
    const create = await fetch(`${hub.base}/api/tickets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `scope_session=${tokA}`,
        'X-Scope-Workspace': pa.tenantId, // legacy selector — validated, not trusted
      },
      body: JSON.stringify({ type: 'story', title: 'replica ticket', by: A }),
    });
    assert.equal(create.status, 201, 'POST /api/tickets works against the tenant replica');
    const ticket = await create.json();
    assert.match(ticket.id, /^A/, 'ticket id uses the project-derived key');

    // Comment + read back through the generic surface.
    const comment = await fetch(`${hub.base}/api/tickets/${ticket.id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `scope_session=${tokA}`, 'X-Scope-Workspace': pa.tenantId },
      body: JSON.stringify({ body: 'hello from a tenant', author: A }),
    });
    assert.equal(comment.status, 201);
    const list = await (await fetch(`${hub.base}/api/tickets?workspace=${pa.tenantId}`, {
      headers: { Cookie: `scope_session=${tokA}` },
    })).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'replica ticket');

    // The write was flushed to the canonical PG log: it shows in tenant sync pull.
    const pulled = await (await authGet(hub.base, `/api/sync/pull?project=${pa.tenantId}`, tokA)).json();
    assert.ok(pulled.events.some((e) => e.kind === 'ticket.create'), 'replica flush reached the PG log');

    // B's tenant sees none of it through the same generic surface…
    const bList = await (await fetch(`${hub.base}/api/tickets?workspace=${pb.tenantId}`, {
      headers: { Cookie: `scope_session=${tokB}` },
    })).json();
    assert.equal(bList.length, 0, 'tenant B sees no tenant-A tickets');

    // …and B cannot read A's board through it either (404, no disclosure).
    const cross = await fetch(`${hub.base}/api/tickets?workspace=${pa.tenantId}`, {
      headers: { Cookie: `scope_session=${tokB}` },
    });
    assert.equal(cross.status, 404, 'cross-tenant REST read denied');
  } finally { await hub.close(); }
});

test('replica REST: invite grants access through the real server; viewer still cannot write', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const C = await upsertAccount(hub.pool, { email: uniq('c') + '@t.test', provider: 'github', providerSub: uniq('c') });
    const tokA = sess(A), tokC = sess(C);
    const pa = await (await authPost(hub.base, '/api/projects', tokA, { name: 'Alpha' })).json();

    // Owner invites C as viewer; C accepts — all over the wired server.
    const inv = await (await authPost(hub.base, `/api/projects/${pa.tenantId}/invites`, tokA, { role: 'viewer' })).json();
    assert.ok(inv.code, 'invite code issued once');
    const accept = await authPost(hub.base, '/api/invites/accept', tokC, { code: inv.code });
    assert.equal(accept.status, 200);
    assert.equal((await accept.json()).tenantId, pa.tenantId);

    // C can now read A's board via the generic REST surface…
    const read = await fetch(`${hub.base}/api/tickets?workspace=${pa.tenantId}`, {
      headers: { Cookie: `scope_session=${tokC}` },
    });
    assert.equal(read.status, 200, 'accepted invite grants read');

    // …but cannot mutate it (viewer).
    const write = await fetch(`${hub.base}/api/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `scope_session=${tokC}`, 'X-Scope-Workspace': pa.tenantId },
      body: JSON.stringify({ type: 'story', title: 'nope', by: C }),
    });
    assert.equal(write.status, 403, 'viewer cannot write through the replica gate');
  } finally { await hub.close(); }
});

test('aliases (SCP-184): claiming a local actor name lets its history sync; conflicts are 409', { skip }, async () => {
  const hub = await startHostedHub();
  try {
    const A = await upsertAccount(hub.pool, { email: uniq('a') + '@t.test', provider: 'github', providerSub: uniq('a') });
    const B = await upsertAccount(hub.pool, { email: uniq('b') + '@t.test', provider: 'github', providerSub: uniq('b') });
    const tokA = sess(A), tokB = sess(B);
    const pa = await (await authPost(hub.base, '/api/projects', tokA, { name: 'Alpha' })).json();

    // A's local log is stamped with the human name "bri" — push fails unclaimed.
    const localEvents = ticketEvent('bri', 'my local history');
    const before = await authPost(hub.base, `/api/sync/push?project=${pa.tenantId}`, tokA, { events: localEvents });
    assert.equal(before.status, 403);
    assert.equal((await before.json()).code, 'ACTOR_MISMATCH');

    // A claims the alias; the same push now lands.
    const claim = await authPost(hub.base, `/api/projects/${pa.tenantId}/aliases`, tokA, { alias: 'bri' });
    assert.equal(claim.status, 201);
    const after = await authPost(hub.base, `/api/sync/push?project=${pa.tenantId}`, tokA, { events: localEvents });
    assert.equal(after.status, 200, 'claimed alias unlocks the local history');

    // B (added as member) cannot claim the same alias on this board.
    await setMembership(hub.pool, { tenantId: pa.tenantId, accountId: B, role: 'member' });
    const steal = await authPost(hub.base, `/api/projects/${pa.tenantId}/aliases`, tokB, { alias: 'bri' });
    assert.equal(steal.status, 409, 'alias is first-come per project');
    assert.equal((await steal.json()).code, 'ALIAS_TAKEN');

    // …and B pushing events as "bri" is still refused.
    const forged = await authPost(hub.base, `/api/sync/push?project=${pa.tenantId}`, tokB, { events: ticketEvent('bri', 'forged') });
    assert.equal(forged.status, 403);
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
