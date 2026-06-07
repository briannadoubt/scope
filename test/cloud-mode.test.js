import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { loadOrCreateToken } from '../src/auth.js';
import { updateWorkspace, createTicket } from '../src/repo.js';

/**
 * SCP-161 (Milestone A) — hosted/cloud mode of the existing single-instance hub.
 * SCOPE_CLOUD binds 0.0.0.0, drops Bonjour + LAN TLS, and — critically —
 * requires the bearer token on EVERY request (no loopback bypass, since behind
 * a reverse proxy requests can appear to originate from loopback). /healthz
 * stays open for the platform LB. Realtime still works via the in-process bus.
 */
async function startCloudHub() {
  const scope = createTempScope();
  updateWorkspace(scope.db, { key: 'TST', name: 'Test' }, 'bri');
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  try { ws.db.close(); } catch {}
  ws.db = scope.db;
  const server = await startServer({
    workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false,
    cloud: true,
  });
  const port = server.address().port;
  return {
    server, scope, wsId: ws.id,
    base: `http://127.0.0.1:${port}`,
    token: loadOrCreateToken(),
    async close() { await new Promise((r) => server.close(() => r())); scope.cleanup(); },
  };
}

test('cloud: /healthz is open; authed routes 401 WITHOUT the token even from loopback', async () => {
  const hub = await startCloudHub();
  try {
    const h = await fetch(`${hub.base}/healthz`);
    assert.equal(h.status, 200, '/healthz needs no auth');
    assert.deepEqual(await h.json(), { status: 'ok' });

    // The security crux: in cloud mode the loopback bypass is OFF, so a request
    // from 127.0.0.1 with no token is rejected (in LAN mode it would pass).
    const noAuth = await fetch(`${hub.base}/api/board?workspace=${hub.wsId}`);
    assert.equal(noAuth.status, 401, 'no loopback bypass in cloud mode');

    const withAuth = await fetch(`${hub.base}/api/board?workspace=${hub.wsId}`, {
      headers: { Authorization: `Bearer ${hub.token}` },
    });
    assert.equal(withAuth.status, 200, 'bearer token grants access');
  } finally {
    await hub.close();
  }
});

test('cloud: realtime SSE is live (in-process bus) and also requires the token', async () => {
  const hub = await startCloudHub();
  try {
    const noAuth = await fetch(`${hub.base}/events`);
    assert.equal(noAuth.status, 401, 'SSE requires auth in cloud mode');

    const ctrl = new AbortController();
    const res = await fetch(`${hub.base}/events?workspace=${hub.wsId}`, {
      headers: { Authorization: `Bearer ${hub.token}` },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    // Read the first frames; a mutation should surface as a change event,
    // proving the realtime channel is live on a single cloud instance.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 4000;
    // Trigger a change after the stream is open.
    createTicket(hub.scope.db, { type: 'story', title: 'live', actor: 'bri' });
    let sawChange = false;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('event: hello')) { /* connected */ }
      if (buf.includes('event: change')) { sawChange = true; break; }
    }
    ctrl.abort();
    assert.ok(sawChange, 'a mutation reached the SSE stream (realtime works)');
  } finally {
    await hub.close();
  }
});
