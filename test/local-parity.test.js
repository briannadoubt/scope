import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { hostedAuthEnabled } from '../src/auth_hosted/cloud-auth.js';

/**
 * SCP-183 — local-path parity guard. The hosted multi-tenant auth + public
 * marketing site (epics SCP-167 / SCP-176) must be CLOUD-ONLY: the local/LAN
 * `scope serve` path is unchanged, and the public site is never served locally
 * (ADR 0003 §5). These tests fail loudly if a future cloud change leaks into
 * the local path.
 */
async function startHub({ cloud }) {
  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  try { ws.db.close(); } catch {}
  ws.db = scope.db;
  const server = await startServer({
    workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false, cloud,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, scope, wsId: ws.id, base,
    async close() { await new Promise((r) => server.close(() => r())); scope.cleanup(); } };
}

const SPA_MARKER = 'src="./app.js"'; // unique to the kanban app's index.html

test('local: / serves the kanban app SPA (not a landing page)', async () => {
  const hub = await startHub({ cloud: false });
  try {
    const r = await fetch(`${hub.base}/`);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.includes(SPA_MARKER), 'local / must serve the app SPA');
  } finally { await hub.close(); }
});

test('local: loopback bypass still authenticates same-machine requests (no token)', async () => {
  const hub = await startHub({ cloud: false });
  try {
    const r = await fetch(`${hub.base}/api/board?workspace=${hub.wsId}`);
    assert.equal(r.status, 200, 'loopback bypass must keep working on the local path');
  } finally { await hub.close(); }
});

test('local: the public marketing site is NOT mounted (/, /features serve the app)', async () => {
  const hub = await startHub({ cloud: false });
  try {
    // In local mode the SPA catch-all answers any path with the app — the
    // public /features page must NOT exist here.
    const r = await fetch(`${hub.base}/features`);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.includes(SPA_MARKER), '/features must fall through to the app locally, not a marketing page');
  } finally { await hub.close(); }
});

test('local: no /auth/* login routes are mounted', async () => {
  const hub = await startHub({ cloud: false });
  try {
    // /auth/login would 302 to a provider if it existed. Locally it must just
    // fall through to the SPA (no redirect, app HTML).
    const r = await fetch(`${hub.base}/auth/login`, { redirect: 'manual' });
    assert.notEqual(r.status, 302, 'no OAuth redirect should exist on the local path');
    const body = await r.text();
    assert.ok(body.includes(SPA_MARKER), '/auth/login must fall through to the app locally');
  } finally { await hub.close(); }
});

test('cloud (no Postgres): public site serves / and the app moves behind auth at /app', async () => {
  const hub = await startHub({ cloud: true });
  try {
    // Landing is public and is NOT the app SPA.
    const root = await fetch(`${hub.base}/`);
    assert.equal(root.status, 200, 'cloud / (landing) is public');
    const rootBody = await root.text();
    assert.ok(!rootBody.includes(SPA_MARKER), 'cloud / must be the landing, not the app SPA');

    // The app is relocated to /app and gated (interim shared-token, no token => 401).
    const app = await fetch(`${hub.base}/app`);
    assert.equal(app.status, 401, 'cloud /app is gated');
  } finally { await hub.close(); }
});

test('hostedAuthEnabled gate: off unless cloud + Postgres + JWT secret', () => {
  const saved = { pg: process.env.SCOPE_PG_URL, db: process.env.DATABASE_URL, jwt: process.env.SCOPE_JWT_SECRET };
  try {
    delete process.env.SCOPE_PG_URL; delete process.env.DATABASE_URL; delete process.env.SCOPE_JWT_SECRET;
    assert.equal(hostedAuthEnabled(false), false, 'never on locally');
    assert.equal(hostedAuthEnabled(true), false, 'cloud alone is not enough');

    process.env.SCOPE_PG_URL = 'postgres://x';
    assert.equal(hostedAuthEnabled(true), false, 'PG without a JWT secret is not enough');

    process.env.SCOPE_JWT_SECRET = 'scope-test-jwt-secret-9f3a7c1e2b8d4506';
    assert.equal(hostedAuthEnabled(true), true, 'cloud + PG + JWT secret => enabled');
    assert.equal(hostedAuthEnabled(false), false, 'still off locally even with config present');
  } finally {
    for (const [k, v] of [['SCOPE_PG_URL', saved.pg], ['DATABASE_URL', saved.db], ['SCOPE_JWT_SECRET', saved.jwt]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
