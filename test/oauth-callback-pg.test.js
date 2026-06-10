import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { getPool, closePool, pgUrl } from '../src/pg/pool.js';
import { ensureAuthSchema } from '../src/auth_hosted/schema.js';

/**
 * SCP-229 — FULL GitHub OAuth callback round-trip over HTTP against a real
 * Postgres, with github.com STUBBED. This closes the last verification gap on
 * the live wiring: cloud-auth.js publicAuthRouter (/auth/login → /auth/callback)
 * + github.js handleGithubCallback + membership.upsertAccount + first-login
 * createProjectBoard + issueSession, end to end. Only the actual github.com
 * network round-trips remain untested (we replace globalThis.fetch for the three
 * GitHub endpoints; everything else — including the test's own calls to the
 * local hub — passes through to the real fetch).
 *
 * What this proves, in one flow:
 *   1. GET /auth/login (GitHub branch) 302s to github.com/login/oauth/authorize
 *      and sets the scope_oauth_state cookie (gh:<state>:<verifier>).
 *   2. GET /auth/callback?code&state, with that cookie, exchanges the code via
 *      the stub, upserts a real account, creates the first-login project board,
 *      issues the scope_session cookie, and 302s to /app.
 *   3. The issued scope_session cookie authenticates a follow-up GET /api/meta
 *      (200, body.hosted === true).
 *   4. The account + its owner membership now exist in Postgres.
 *
 * Skip-if-no-PG with the same guard pattern as test/cloud-auth-pg.test.js so the
 * suite still passes on a machine without the test database.
 */

/* --- config gate: MUST be set before startServer reads hostedAuthEnabled --- */
// PG + JWT power hostedAuthEnabled(cloud); the GitHub trio powers the /auth/login
// GitHub branch and the token-exchange env reads in handleGithubCallback. The
// redirect value only needs to be consistent — the test drives the callback
// directly, so it never has to match a live port.
process.env.SCOPE_PG_URL =
  process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';
process.env.SCOPE_JWT_SECRET =
  process.env.SCOPE_JWT_SECRET || 'scope-test-jwt-secret-9f3a7c1e2b8d4506';
process.env.SCOPE_GITHUB_CLIENT_ID = process.env.SCOPE_GITHUB_CLIENT_ID || 'test-gh-client-id';
process.env.SCOPE_GITHUB_CLIENT_SECRET =
  process.env.SCOPE_GITHUB_CLIENT_SECRET || 'test-gh-client-secret';
process.env.SCOPE_GITHUB_REDIRECT =
  process.env.SCOPE_GITHUB_REDIRECT || 'http://localhost/auth/callback';

let available = false;
try {
  const c = new pg.Client({ connectionString: pgUrl(), connectionTimeoutMillis: 1500 });
  await c.connect(); await c.end(); available = true;
} catch { /* skip */ }
const skip = available ? false : 'no Postgres reachable (run: docker compose up -d)';

/* --------------------------------- helpers -------------------------------- */

// SCP-229: start the hosted hub exactly like test/cloud-auth-pg.test.js does.
async function startCloudHubPG() {
  const pool = getPool();
  await ensureAuthSchema(pool); // accounts/projects/memberships/... (createProjectBoard needs these)

  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  // Re-use the open db handle so we don't leak two handles on the temp dir.
  try { ws.db.close(); } catch {}
  ws.db = scope.db;

  const server = await startServer({
    workspaces: mgr, port: 0, silent: true, discoverable: false, tls: false, cloud: true,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server, scope, pool, base,
    async close() {
      await new Promise((r) => server.close(() => r()));
      try { mgr.detach(ws.id, { persist: false, broadcast: false }); } catch {}
      scope.cleanup();
    },
  };
}

// Pull a single cookie's value out of a Set-Cookie header value (which may be a
// single string or — via node's getSetCookie — an array of them).
function cookieFrom(setCookie, name) {
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const c of list) {
    const m = new RegExp(`(?:^|, )${name}=([^;]+)`).exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

// A minimal Response-shaped object for the fetch stub (json()/text()/ok/status).
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); },
  };
}

/* ---------------------------------- test ---------------------------------- */

test('SCP-229: GET /auth/login → /auth/callback (stubbed GitHub) upserts an account, sets scope_session, 302s to /app, and the cookie authenticates /api/meta', { skip }, async () => {
  const hub = await startCloudHubPG();
  const realFetch = globalThis.fetch; // restore in finally even on failure (shared process)
  try {
    /* 1. /auth/login: 302 to GitHub authorize; capture state + the state cookie. */
    const login = await fetch(`${hub.base}/auth/login`, { redirect: 'manual' });
    assert.equal(login.status, 302, '/auth/login redirects to the provider');
    const authorizeUrl = login.headers.get('location');
    assert.ok(
      authorizeUrl && authorizeUrl.startsWith('https://github.com/login/oauth/authorize'),
      'redirects to github.com/login/oauth/authorize',
    );
    const state = new URL(authorizeUrl).searchParams.get('state');
    assert.ok(state, 'authorize URL carries a state param');

    const loginSetCookie = login.headers.getSetCookie?.() ?? login.headers.get('set-cookie');
    const stateCookie = cookieFrom(loginSetCookie, 'scope_oauth_state');
    assert.ok(stateCookie && stateCookie.startsWith(`gh:${state}:`), 'state cookie is gh:<state>:<verifier>');

    /* 2. Stub github.com/login + api.github.com; pass everything else (the hub) through. */
    const ghId = 4242 + (Date.now() % 100000); // distinct provider_sub per run (idempotent reruns)
    const ghLogin = `scp229-${ghId}`;
    const email = `scp229+${ghId}@scope.test`;
    let tokenExchangeSeen = false;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        tokenExchangeSeen = true;
        return jsonResponse({ access_token: 'gho_x', token_type: 'bearer', scope: 'read:user user:email' });
      }
      if (url === 'https://api.github.com/user') {
        return jsonResponse({ id: ghId, login: ghLogin, name: 'SCP-229 User' });
      }
      if (url === 'https://api.github.com/user/emails') {
        return jsonResponse([{ email, primary: true, verified: true }]);
      }
      // Non-GitHub (e.g. this test's own calls to the local hub) → real fetch.
      return realFetch(input, init);
    };

    /* 3. /auth/callback: 302 to /app + a scope_session cookie. */
    const callback = await fetch(
      `${hub.base}/auth/callback?code=fakecode&state=${encodeURIComponent(state)}`,
      { redirect: 'manual', headers: { Cookie: `scope_oauth_state=${encodeURIComponent(stateCookie)}` } },
    );
    assert.equal(callback.status, 302, '/auth/callback redirects after a successful login');
    assert.equal(callback.headers.get('location'), '/app', 'lands in the app');
    assert.ok(tokenExchangeSeen, 'the stub saw the GitHub token exchange (the flow actually ran)');

    const cbSetCookie = callback.headers.getSetCookie?.() ?? callback.headers.get('set-cookie');
    const session = cookieFrom(cbSetCookie, 'scope_session');
    assert.ok(session, 'callback issues a scope_session cookie');

    /* 4. The issued session cookie authenticates /api/meta. */
    const meta = await fetch(`${hub.base}/api/meta`, { headers: { Cookie: `scope_session=${session}` } });
    assert.equal(meta.status, 200, 'the issued session cookie authenticates a real request');
    const body = await meta.json();
    assert.equal(body.hosted, true, 'hosted auth path is active');

    // Sanity: that cookie is load-bearing — without it /api/meta is 401.
    const anon = await fetch(`${hub.base}/api/meta`);
    assert.equal(anon.status, 401, 'no cookie → unauthorized (the cookie did the work)');

    /* 5. The account + its first-login owner membership now exist in Postgres. */
    const acct = (await hub.pool.query(
      'SELECT id, email FROM accounts WHERE provider=$1 AND provider_sub=$2',
      ['github', String(ghId)],
    )).rows[0];
    assert.ok(acct, 'upsertAccount created the account (by provider/provider_sub)');
    assert.equal(acct.email, email, 'the account carries the stubbed primary email');

    const membership = (await hub.pool.query(
      'SELECT role FROM memberships WHERE account_id=$1', [acct.id],
    )).rows[0];
    assert.ok(membership, 'first-login createProjectBoard made a membership row');
    assert.equal(membership.role, 'owner', 'the new account owns its first project');
  } finally {
    globalThis.fetch = realFetch; // SCP-229: never leave the global stubbed for other tests
    await hub.close();
    await closePool();
  }
});
