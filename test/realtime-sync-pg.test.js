import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { openDb } from '../src/db.js';
import { createTicket, listTickets } from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { replayInto } from '../src/replay.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import { ensureAuthSchema } from '../src/auth_hosted/schema.js';
import { upsertAccount, createProject } from '../src/auth_hosted/membership.js';
import { createProjectBoard } from '../src/auth_hosted/tenant-board.js';
import { mintAccessToken } from '../src/auth_hosted/sessions.js';
import { startRemoteSync } from '../src/remote-sync.js';

/**
 * SCP-224 — END-TO-END realtime-sync tests for the RemoteSyncAgent
 * (src/remote-sync.js). Proves a local .scope is a LIVE bidirectional mirror of
 * a hosted project with NO manual `scope sync` call: a write on one replica
 * propagates to the other on its own (PUSH on the local change bus + PULL driven
 * by the hub's /events SSE stream + an interval catch-up backstop), all routed
 * through the idempotent syncWithRemote primitive (ULID union, safe to double-run).
 *
 * Skip-if-no-DB so CI without Postgres still passes the rest of the suite
 * (run: docker compose up -d). Mirrors the setup in test/multi-tenant-pg.test.js
 * and test/cloud-auth-pg.test.js.
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

// SCP-224: tune the agent tight so a round fires almost immediately and the
// catch-up backstop ticks frequently — tests converge in well under a second
// while still proving the debounce + interval machinery is wired.
const AGENT_OPTS = { debounceMs: 20, intervalMs: 250 };

/**
 * Poll `cond` until it returns truthy or we hit `timeoutMs`. SCP-224 leans on
 * this everywhere instead of fixed sleeps: assert on CONVERGENCE (the other
 * replica eventually shows the write), never on timing or exact push counts —
 * the change bus is process-global, so one local write fires 'change' for every
 * agent in the process and exact counts are meaningless.
 */
async function until(cond, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await cond(); } catch { v = false; }
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Titles currently on a local replica's board (any column). */
function titles(db) {
  return listTickets(db).map((t) => t.title);
}

/** Sorted ULIDs (uids) of every ticket on a local replica's board. */
function uids(db) {
  return listTickets(db).map((t) => t.uid).sort();
}

/**
 * Bring up a hosted hub on a real PG-backed cloud server, seed one account +
 * project, and mint an owner session. The owner's accountId is used as the
 * `actor` on every local write so pushes pass the actor-authz gate (SCP-172):
 * an event whose actor IS the authenticated principal is accepted.
 */
async function startHostedHub() {
  const pool = getPool();
  await ensureAuthSchema(pool);
  const accountId = await upsertAccount(pool, {
    email: `rt+${Date.now()}_${Math.round(performance.now() * 1000)}@scope.test`,
    name: 'RT', provider: 'github', providerSub: `rt-${Date.now()}-${Math.round(performance.now() * 1000)}`,
  });
  // createProjectBoard also seeds a workspace.init so the tenant board exists.
  const { tenantId } = await createProjectBoard(pool, { accountId, name: 'Realtime' });

  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  try { ws.db.close(); } catch {}
  ws.db = scope.db;
  const server = await startServer({
    workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false, cloud: true,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = mintAccessToken({ sub: accountId, tenant_id: tenantId, role: 'owner' });
  return {
    server, scope, pool, accountId, tenantId, token, base,
    async close() {
      await new Promise((r) => server.close(() => r()));
      scope.cleanup();
    },
  };
}

/** Open a fresh local replica (its own .scope dir + db) pointed at the hub. */
function makeReplica() {
  const scope = createTempScope();
  return {
    scopeDir: scope.scopeDir,
    db: scope.db,
    cleanup: scope.cleanup,
  };
}

test('SCP-224: live propagation in both directions with no manual sync', { skip }, async () => {
  const hub = await startHostedHub();
  const A = makeReplica();
  const B = makeReplica();
  let agentA, agentB;
  try {
    const common = { remote: hub.base, project: hub.tenantId, token: hub.token, ...AGENT_OPTS };
    agentA = startRemoteSync(A.db, A.scopeDir, common);
    agentB = startRemoteSync(B.db, B.scopeDir, common);

    // Wait until both agents have actually opened their SSE streams + done an
    // initial reconcile, so the PULL path is live before we write.
    await until(() => agentA.status().rounds > 0 && agentB.status().rounds > 0, 3000);

    // Write on A. NO manual sync call — the local change bus must drive the push
    // and B's SSE stream must drive the pull.
    createTicket(A.db, { type: 'story', title: 'born-on-A', actor: hub.accountId });
    const onB = await until(() => titles(B.db).includes('born-on-A'), 3000);
    assert.ok(onB, 'A->B: ticket created on A propagated to B within ~3s, no manual sync');

    // Now the other direction: write on B, assert it lands on A.
    createTicket(B.db, { type: 'bug', title: 'born-on-B', actor: hub.accountId });
    const onA = await until(() => titles(A.db).includes('born-on-B'), 3000);
    assert.ok(onA, 'B->A: ticket created on B propagated to A within ~3s, no manual sync');
  } finally {
    agentA?.stop();
    agentB?.stop();
    A.cleanup();
    B.cleanup();
    await hub.close();
  }
});

test('SCP-224: offline replica catches up on reconnect via cursor resume', { skip }, async () => {
  const hub = await startHostedHub();
  const A = makeReplica();
  const B = makeReplica();
  let agentA, agentB, agentB2;
  try {
    const common = { remote: hub.base, project: hub.tenantId, token: hub.token, ...AGENT_OPTS };
    agentA = startRemoteSync(A.db, A.scopeDir, common);
    agentB = startRemoteSync(B.db, B.scopeDir, common);
    await until(() => agentA.status().rounds > 0 && agentB.status().rounds > 0, 3000);

    // B goes offline (agent torn down). Its scopeDir + db stay put.
    agentB.stop();
    agentB = null;

    // A writes while B is dark — A's agent still pushes it to the hub.
    createTicket(A.db, { type: 'story', title: 'while-B-offline', actor: hub.accountId });
    // Confirm it actually reached the hub (it round-trips back onto A).
    await until(() => titles(A.db).includes('while-B-offline'), 3000);

    // Sanity: B did NOT see it while offline (no agent => no pull).
    assert.ok(!titles(B.db).includes('while-B-offline'), 'offline B has not yet caught up');

    // A FRESH agent on B's SAME scopeDir+db reconnects. The onOpen catch-up
    // round (cursor-based resume from B's persisted high-water mark) must fold
    // in everything B missed.
    agentB2 = startRemoteSync(B.db, B.scopeDir, common);
    const caughtUp = await until(() => titles(B.db).includes('while-B-offline'), 3000);
    assert.ok(caughtUp, 'reconnected B2 caught up the missed ticket via onOpen catch-up');
  } finally {
    agentA?.stop();
    agentB?.stop();
    agentB2?.stop();
    A.cleanup();
    B.cleanup();
    await hub.close();
  }
});

test('SCP-224: concurrent writes converge idempotently with no duplicates', { skip }, async () => {
  const hub = await startHostedHub();
  const A = makeReplica();
  const B = makeReplica();
  let agentA, agentB;
  try {
    const common = { remote: hub.base, project: hub.tenantId, token: hub.token, ...AGENT_OPTS };
    agentA = startRemoteSync(A.db, A.scopeDir, common);
    agentB = startRemoteSync(B.db, B.scopeDir, common);
    await until(() => agentA.status().rounds > 0 && agentB.status().rounds > 0, 3000);

    // Rapidly interleave writes on BOTH replicas. Each createTicket mints a
    // globally-unique ULID, so the union is well-defined and conflict-free.
    const expected = [];
    for (let i = 0; i < 5; i++) {
      const a = createTicket(A.db, { type: 'story', title: `A-${i}`, actor: hub.accountId });
      const b = createTicket(B.db, { type: 'story', title: `B-${i}`, actor: hub.accountId });
      expected.push(a.uid, b.uid);
    }
    const wantCount = expected.length; // 10 distinct tickets

    // Let activity settle: both boards must reach the SAME full set of uids.
    const converged = await until(() => {
      const ua = uids(A.db);
      const ub = uids(B.db);
      return ua.length === wantCount && ub.length === wantCount &&
        ua.join(',') === ub.join(',');
    }, 5000);
    assert.ok(converged, 'both replicas converged to the identical uid set');

    const ua = uids(A.db);
    const ub = uids(B.db);
    assert.deepEqual(ua, ub, 'A and B hold the identical sorted uid list');
    assert.deepEqual(ua, [...expected].sort(), 'the converged set is exactly the writes');
    // No duplicates: a Set of the uids has the same size as the list.
    assert.equal(new Set(ua).size, ua.length, 'no duplicate uids on A');
    assert.equal(new Set(ub).size, ub.length, 'no duplicate uids on B');
  } finally {
    agentA?.stop();
    agentB?.stop();
    A.cleanup();
    B.cleanup();
    await hub.close();
  }
});

test('SCP-224: incremental apply on pull equals a from-scratch full replay', { skip }, async () => {
  const hub = await startHostedHub();
  const A = makeReplica();
  const B = makeReplica();
  let agentA, agentB;
  let freshScope;
  try {
    const common = { remote: hub.base, project: hub.tenantId, token: hub.token, ...AGENT_OPTS };
    agentA = startRemoteSync(A.db, A.scopeDir, common);
    agentB = startRemoteSync(B.db, B.scopeDir, common);
    await until(() => agentA.status().rounds > 0 && agentB.status().rounds > 0, 3000);

    // A sequence of synced writes from both sides, so B's board is built by the
    // incremental apply path (applyEvents on each pull), not a full replay.
    const wantUids = [];
    for (let i = 0; i < 4; i++) {
      const a = createTicket(A.db, { type: 'story', title: `seq-A-${i}`, actor: hub.accountId });
      const b = createTicket(B.db, { type: 'bug', title: `seq-B-${i}`, actor: hub.accountId });
      wantUids.push(a.uid, b.uid);
    }
    await until(() => uids(B.db).length === wantUids.length, 5000);

    // Ground truth: rebuild a THROWAWAY db from a full replay of B's own event
    // log. If the incremental apply on pull is correct, B's live board must
    // equal that from-scratch projection exactly.
    freshScope = createTempScope();
    const truth = openDb(freshScope.scopeDir);
    replayInto(truth, readAllEvents(eventsDir(B.scopeDir)));

    const liveUids = uids(B.db);
    const replayUids = listTickets(truth).map((t) => t.uid).sort();
    assert.deepEqual(liveUids, replayUids,
      'B live board (incremental apply) matches a full replay of its log');

    const liveTitles = titles(B.db).sort();
    const replayTitles = listTickets(truth).map((t) => t.title).sort();
    assert.deepEqual(liveTitles, replayTitles,
      'titles match between incremental apply and full replay');
    try { truth.close(); } catch {}
  } finally {
    agentA?.stop();
    agentB?.stop();
    freshScope?.cleanup();
    A.cleanup();
    B.cleanup();
    await hub.close();
  }
});

test('SCP-224: stop() tears down cleanly — no leaked handles (a hang IS the failure)', { skip }, async () => {
  const hub = await startHostedHub();
  const A = makeReplica();
  const B = makeReplica();
  let agentA, agentB;
  try {
    const common = { remote: hub.base, project: hub.tenantId, token: hub.token, ...AGENT_OPTS };
    agentA = startRemoteSync(A.db, A.scopeDir, common);
    agentB = startRemoteSync(B.db, B.scopeDir, common);
    await until(() => agentA.status().rounds > 0 && agentB.status().rounds > 0, 3000);

    // Drive some activity so timers/SSE are genuinely in-flight at stop() time.
    createTicket(A.db, { type: 'story', title: 'pre-teardown', actor: hub.accountId });
    await until(() => titles(B.db).includes('pre-teardown'), 3000);

    // stop() must remove the bus listener, clear the debounce + interval timers,
    // and close the SSE socket. Idempotent: a second stop() is a no-op.
    agentA.stop();
    agentB.stop();
    assert.equal(agentA.status().stopped, true, 'agent A reports stopped');
    assert.equal(agentB.status().stopped, true, 'agent B reports stopped');
    agentA.stop(); // idempotent — must not throw
    agentB.stop();

    // After stop(), a fresh local write must NOT drive any further rounds: the
    // bus listener is gone, so rounds stays put.
    const roundsA = agentA.status().rounds;
    createTicket(A.db, { type: 'story', title: 'post-teardown', actor: hub.accountId });
    await new Promise((r) => setTimeout(r, AGENT_OPTS.intervalMs * 3));
    assert.equal(agentA.status().rounds, roundsA, 'no rounds after stop() — listener + timers gone');

    agentA = null;
    agentB = null;
  } finally {
    // If anything above leaked a timer/socket, the process won't exit and the
    // test runner hangs — that hang is the failure signal for teardown (SCP-224).
    agentA?.stop();
    agentB?.stop();
    A.cleanup();
    B.cleanup();
    await hub.close();
  }
});

// SCP-224: release the shared PG pool last so the process exits cleanly.
test('SCP-224: close shared PG pool', { skip }, async () => {
  await closePool();
});
