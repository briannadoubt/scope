/**
 * SCP-114 — LAN peer gossip integration tests.
 *
 * Spins up TWO real dual-stack servers (HTTP loopback + HTTPS LAN, per
 * test/mtls.test.js) whose workspaces are replicas of one board (same
 * workspace KEY, seeded from one event log per test/sync-convergence.test.js),
 * pairs a device cert against the (shared, test-HOME) CA, and runs a gossip
 * engine on each "machine" pointed at the other. Asserts: realtime A→B and
 * B→A convergence with no central host, idempotence (an extra explicit round
 * moves nothing — duplicates only), per-peer failure isolation, and clean
 * teardown (the test process exiting IS the no-leaked-handles assertion;
 * node --test hangs otherwise).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { startServer } from '../src/server.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { createTempScope } from './helpers.js';
import { loadOrCreateCa, HUB_DIR, issueLeafCert } from '../src/ca.js';
import { addDevice, _resetLastSeenCache } from '../src/devices.js';
import { updateWorkspace, createTicket, listTickets } from '../src/repo.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { ensureEventLog } from '../src/backfill.js';
import { syncFromLog } from '../src/replay.js';
import { startGossip } from '../src/gossip.js';

function resetHub() {
  try { rmSync(HUB_DIR, { recursive: true, force: true }); } catch {}
  _resetLastSeenCache();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until truthy or `timeoutMs` elapses (then reject with `label`). */
function waitFor(fn, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = fn(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for: ${label}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Sorted ULID set of a replica's event log. */
function idSet(scopeDir) {
  return readAllEvents(eventsDir(scopeDir)).map((e) => e.id).sort();
}

/** "git clone": union the event files from src into dst (per sync-convergence). */
function copyEvents(srcScopeDir, dstScopeDir) {
  const src = eventsDir(srcScopeDir);
  const dst = eventsDir(dstScopeDir);
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    if (f.endsWith('.json') && !f.startsWith('.')) copyFileSync(join(src, f), join(dst, f));
  }
}

/**
 * Two temp workspaces that are replicas of ONE board: A seeds the key + an
 * authoritative log (workspace.init), B clones A's event files — so both share
 * the workspace KEY ("GSP") that gossip matches peers by.
 */
function seedReplicaPair() {
  const a = createTempScope();
  updateWorkspace(a.db, { key: 'GSP', name: 'Gossip' }, 'seed');
  ensureEventLog(a.db, a.scopeDir);
  syncFromLog(a.db, a.scopeDir);
  const b = createTempScope();
  copyEvents(a.scopeDir, b.scopeDir);
  syncFromLog(b.db, b.scopeDir);
  return { a, b };
}

/**
 * One "machine": a dual-stack server (default tls → HTTPS LAN listener with
 * the local CA) attached to the given pre-seeded workspace. Mirrors
 * test/mtls.test.js startHttpsServer, but takes the scope so replicas can be
 * seeded before attach.
 */
async function startMachine(scope) {
  const mgr = new WorkspaceManager();
  const w = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  // Reuse the already-open handle so the test can seed/inspect directly.
  try { w.db.close(); } catch {}
  w.db = scope.db;
  const server = await startServer({
    workspaces: mgr,
    port: 0,
    silent: true,
    discoverable: false,
    // default tls → HTTP loopback + HTTPS LAN with the shared local CA
  });
  const lanAddr = server._lanServer?.address() ?? null;
  return {
    server,
    lanAddr,
    url: lanAddr ? `https://${lanAddr.address}:${lanAddr.port}` : null,
    ca: server._tls?.ca ?? null,
    async close() {
      await new Promise((r) => server.close(() => r()));
      mgr.detach(w.id, { persist: false, broadcast: false });
    },
  };
}

/**
 * "Pair" a device: issue a client cert from the CA and register it in
 * devices.json so authMiddleware's deviceFromPeerCert path authenticates it —
 * exactly what /api/pair/complete does, minus the CSR round-trip (covered by
 * test/mtls.test.js / test/pair.test.js).
 */
function pairGossipDevice(ca) {
  const leaf = issueLeafCert({ ca, commonName: 'gossip-peer', kind: 'client' });
  addDevice({
    name: 'gossip-peer',
    certPem: leaf.certPem,
    serialHex: leaf.serialHex,
    notAfter: leaf.notAfter,
  });
  return { certPem: leaf.certPem, keyPem: leaf.keyPem, caPem: ca.certPem };
}

test('gossip — two paired machines converge in realtime over mTLS, idempotently, no central host', async () => {
  resetHub();
  const { a, b } = seedReplicaPair();
  const A = await startMachine(a);
  const B = await startMachine(b);
  if (!A.lanAddr || !B.lanAddr) {
    // No LAN interface in this environment (mirrors mtls.test.js skip).
    await A.close();
    await B.close();
    a.cleanup();
    b.cleanup();
    return;
  }

  let gA = null;
  let gB = null;
  try {
    // Both servers loaded the same CA (shared test HOME), so one paired
    // device cert authenticates against both — same as two machines that
    // ran `scope pair` against each other.
    const clientCert = pairGossipDevice(A.ca);

    // intervalMs is deliberately long: realtime must come from the bus →
    // debounce → push path, not the catch-up tick.
    gA = startGossip({
      scopeDir: a.scopeDir, db: a.db,
      getPeers: () => [{ url: B.url }],
      clientCert, intervalMs: 60_000, debounceMs: 25,
    });
    gB = startGossip({
      scopeDir: b.scopeDir, db: b.db,
      getPeers: () => [{ url: A.url }],
      clientCert, intervalMs: 60_000, debounceMs: 25,
    });

    // A → B: a local mutation on A appears on B within 2s.
    createTicket(a.db, { type: 'story', title: 'Born on A', actor: 'alice' });
    await waitFor(
      () => listTickets(b.db).some((t) => t.title === 'Born on A'),
      2000, 'ticket created on A to appear on B'
    );

    // B → A: and the reverse.
    createTicket(b.db, { type: 'bug', title: 'Born on B', actor: 'bob' });
    await waitFor(
      () => listTickets(a.db).some((t) => t.title === 'Born on B'),
      2000, 'ticket created on B to appear on A'
    );

    // The event logs converge to the identical ULID set — union semantics, so
    // a later `git pull` of the same changes is a no-op.
    await waitFor(
      () => JSON.stringify(idSet(a.scopeDir)) === JSON.stringify(idSet(b.scopeDir)),
      2000, 'event logs to converge to the same ULID set'
    );

    // Idempotence. Let in-flight debounced rounds drain, run one settling
    // round per side (advances pull cursors past the events each side pushed),
    // then assert a further explicit round moves NOTHING: every push is
    // duplicates-only and every pull is empty.
    await sleep(250);
    await gA.runRound();
    await gB.runRound();

    const before = idSet(a.scopeDir);
    assert.ok(before.length >= 3, 'log has the seed + both tickets');
    for (const r of [...(await gA.runRound()), ...(await gB.runRound())]) {
      assert.equal(r.ok, true, `round failed: ${r.error}`);
      assert.equal(r.pushed, 0, 'no new events pushed');
      assert.equal(r.pulled, 0, 'no new events pulled');
      assert.equal(r.duplicates, before.length, 'whole log reported as duplicates');
    }
    assert.deepEqual(idSet(a.scopeDir), before, "A's log unchanged by the extra round");
    assert.deepEqual(idSet(b.scopeDir), before, "B's log unchanged by the extra round");

    // Peer health is tracked and clean.
    assert.deepEqual(gA.peerStatus().map((p) => p.lastError), [null]);
    assert.deepEqual(gB.peerStatus().map((p) => p.lastError), [null]);

    // stop() is awaited, idempotent, and a post-stop round is a no-op.
    await gA.stop();
    await gA.stop();
    assert.deepEqual(await gA.runRound(), [], 'runRound after stop is a no-op');
  } finally {
    await gA?.stop();
    await gB?.stop();
    await A.close();
    await B.close();
    a.cleanup();
    b.cleanup();
  }
  // Teardown proof: clearInterval/clearTimeout, bus.off and agent.destroy all
  // ran — if anything leaked, the node --test process hangs and the run fails.
});

test('gossip — a dead peer is isolated, remembered, and retried on later rounds', async () => {
  const scope = createTempScope();
  let g = null;
  try {
    updateWorkspace(scope.db, { key: 'GSP', name: 'Gossip' }, 'seed');
    ensureEventLog(scope.db, scope.scopeDir);

    let calls = 0;
    const failingFetch = async () => {
      calls += 1;
      throw new Error('connect ECONNREFUSED 192.0.2.1:4443');
    };
    g = startGossip({
      scopeDir: scope.scopeDir, db: scope.db,
      getPeers: () => [{ url: 'https://192.0.2.1:4443' }],
      fetchImpl: failingFetch, intervalMs: 60_000, debounceMs: 5,
    });

    // The failure is isolated (the round resolves, never throws) and recorded.
    const results = await g.runRound();
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /ECONNREFUSED/);
    const [status] = g.peerStatus();
    assert.equal(status.url, 'https://192.0.2.1:4443');
    assert.match(status.lastError, /ECONNREFUSED/);
    assert.equal(status.workspaceId, null, 'failed peer re-resolves its workspace next round');

    // The engine keeps retrying rather than dropping the peer.
    const callsAfterFirst = calls;
    const retry = await g.runRound();
    assert.equal(retry[0].ok, false);
    assert.ok(calls > callsAfterFirst, 'a later round retried the dead peer');
  } finally {
    await g?.stop();
    scope.cleanup();
  }
});

test('gossip — startGossip validates its required options', () => {
  const scope = createTempScope();
  try {
    assert.throws(() => startGossip({}), /scopeDir/);
    assert.throws(() => startGossip({ scopeDir: scope.scopeDir }), /db/);
    assert.throws(
      () => startGossip({ scopeDir: scope.scopeDir, db: scope.db }),
      /getPeers/
    );
    assert.throws(
      () => startGossip({ scopeDir: scope.scopeDir, db: scope.db, getPeers: () => [] }),
      /clientCert/
    );
  } finally {
    scope.cleanup();
  }
});
