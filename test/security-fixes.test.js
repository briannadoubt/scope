import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateEvent, makeEvent } from '../src/event-schema.js';
import { appendEvent } from '../src/event-store.js';
import { csrfGuard } from '../src/auth_hosted/cloud-auth.js';
import { isStrongSecret, mintAccessToken, verifyAccessToken } from '../src/auth_hosted/sessions.js';
import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';

/** Regression tests for the security audit fixes that need no Postgres. */

const ULID = '01KTQNTR8CAQ653FJZPBN5N587';

test('SCP-196: validateEvent rejects a non-ULID id (path-traversal vector)', () => {
  const base = makeEvent('comment.add', { ticketId: ULID, commentId: ULID, author: 'a', body: 'x' }, { actor: 'a' });
  // sanity: the well-formed event validates
  validateEvent(base);
  for (const bad of ['../../etc/passwd', 'not a ulid', '01KTQNTR8CAQ653FJZPBN5N587x', '', '../' + ULID]) {
    assert.throws(() => validateEvent({ ...base, id: bad }), /ULID/, `should reject id ${JSON.stringify(bad)}`);
  }
});

test('SCP-196: appendEvent refuses a traversal id even if validation were bypassed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-evt-'));
  const evil = { v: 1, id: '../../../../tmp/pwned', ts: '2026-01-01T00:00:00.000Z', actor: 'a',
    kind: 'comment.add', payload: { ticketId: ULID, commentId: ULID, author: 'a', body: 'x' } };
  assert.throws(() => appendEvent(dir, evil), /(ULID|unsafe event id)/);
  assert.ok(!existsSync('/tmp/pwned.json'), 'nothing was written outside the events dir');
});

test('SCP-198: workspace.init / workspace.set key must be a valid prefix', () => {
  assert.throws(() => validateEvent(makeEvent('workspace.init', { key: '<img src=x onerror=alert(1)>', name: 'X' }, { actor: 'a' })), /key/);
  assert.throws(() => validateEvent(makeEvent('workspace.set', { key: '"><svg onload=1>' }, { actor: 'a' })), /key/);
  // a valid key still passes
  validateEvent(makeEvent('workspace.init', { key: 'ALPHA', name: 'Alpha' }, { actor: 'a' }));
});

test('SCP-212: isStrongSecret rejects short / degenerate secrets', () => {
  assert.equal(isStrongSecret('aaaaaaaaaaaaaaaa'), false, '16 chars too short');
  assert.equal(isStrongSecret('a'.repeat(40)), false, 'repeated single char = low entropy');
  assert.equal(isStrongSecret('ababababababababababababababababab'), false, 'too few distinct chars');
  assert.equal(isStrongSecret('short'), false);
  assert.equal(isStrongSecret(undefined), false);
  assert.equal(isStrongSecret('Xk7p2Qn9-Lm4Rt8Vw1Zc6Yb3Hf5Jд0Ng'), true, '>=32 chars, diverse');
});

test('SCP-204: csrfGuard blocks cross-site cookie mutations, allows safe + token + same-site', () => {
  const guard = csrfGuard();
  const run = (headers, method = 'POST') => {
    let status = 200, ended = false;
    const req = { method, headers };
    const res = { status(c) { status = c; return this; }, json() { ended = true; return this; } };
    let nexted = false;
    guard(req, res, () => { nexted = true; });
    return { status, blocked: ended && !nexted, nexted };
  };
  // cross-site cookie POST → blocked
  assert.equal(run({ 'sec-fetch-site': 'cross-site' }).status, 403);
  assert.equal(run({ origin: 'https://evil.com', host: 'hub.scope.dev' }).status, 403);
  // same-origin → allowed
  assert.ok(run({ 'sec-fetch-site': 'same-origin' }).nexted);
  assert.ok(run({ origin: 'https://hub.scope.dev', host: 'hub.scope.dev' }).nexted);
  // token-authenticated (no ambient cookie) → allowed even cross-site
  assert.ok(run({ 'sec-fetch-site': 'cross-site', authorization: 'Bearer sk_x.y' }).nexted);
  // safe method → allowed
  assert.ok(run({ 'sec-fetch-site': 'cross-site' }, 'GET').nexted);
});

test('SCP-215: access tokens carry + enforce iss/aud', () => {
  const prev = process.env.SCOPE_JWT_SECRET;
  process.env.SCOPE_JWT_SECRET = 'scope-test-jwt-secret-9f3a7c1e2b8d4506';
  try {
    const tok = mintAccessToken({ sub: 'acct_1' });
    const claims = verifyAccessToken(tok);
    assert.equal(claims.iss, 'scope-hub');
    assert.equal(claims.aud, 'scope-hub-api');
    // A token minted with a foreign audience is rejected.
    const foreign = mintAccessToken({ sub: 'acct_1', aud: 'someone-else' });
    assert.throws(() => verifyAccessToken(foreign), /audience/);
  } finally {
    if (prev === undefined) delete process.env.SCOPE_JWT_SECRET; else process.env.SCOPE_JWT_SECRET = prev;
  }
});

// Local (non-cloud) server harness — loopback bypass means no auth needed.
async function startLocalHub() {
  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  try { ws.db.close(); } catch {}
  ws.db = scope.db;
  const server = await startServer({ workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false, cloud: false });
  return { server, wsId: ws.id, base: `http://127.0.0.1:${server.address().port}`,
    async close() { await new Promise((r) => server.close(() => r())); scope.cleanup(); } };
}

test('SCP-206: sync push rejects an oversized batch', async () => {
  const hub = await startLocalHub();
  try {
    const events = Array.from({ length: 2001 }, () => ({})); // count checked before validation
    const r = await fetch(`${hub.base}/api/sync/push?workspace=${hub.wsId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }),
    });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).code, 'BATCH_TOO_LARGE');
  } finally { await hub.close(); }
});

test('SCP-213: sync push rejects a rendered "on behalf of" actor', async () => {
  const hub = await startLocalHub();
  try {
    const evt = makeEvent('comment.add', { ticketId: ULID, commentId: ULID, author: 'a', body: 'x' },
      { actor: 'Opus on behalf of bob' });
    const r = await fetch(`${hub.base}/api/sync/push?workspace=${hub.wsId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events: [evt] }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'ACTOR_RENDERED');
  } finally { await hub.close(); }
});
