import test from 'node:test';
import assert from 'node:assert/strict';

import { hostedAuthMiddleware } from '../src/auth_hosted/cloud-auth.js';
import { mintAccessToken } from '../src/auth_hosted/sessions.js';
import { generateKey } from '../src/auth_hosted/apikeys.js';

/**
 * SCP-171 — the cloud credential middleware. Exercises both accepted credential
 * kinds (session JWT, per-user API key) and rejection, without Postgres: the
 * JWT path needs no DB, and the API-key path runs against a tiny fake pool.
 */

// Minimal req/res doubles for an Express middleware.
function run(mw, { headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = { headers };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body, principal: req.principal }); },
    };
    mw(req, res, () => resolve({ status: 200, next: true, principal: req.principal }));
  });
}

test('JWT session: a valid access token sets req.principal', async () => {
  const prev = process.env.SCOPE_JWT_SECRET;
  process.env.SCOPE_JWT_SECRET = 's'.repeat(32);
  try {
    const jwt = mintAccessToken({ sub: 'acct_1', tenant_id: 'tnt_1', role: 'owner' });
    const out = await run(hostedAuthMiddleware({ pool: null }), {
      headers: { authorization: `Bearer ${jwt}` },
    });
    assert.ok(out.next, 'passed the gate');
    assert.equal(out.principal.accountId, 'acct_1');
    assert.equal(out.principal.kind, 'session');
    assert.equal(out.principal.tenantId, 'tnt_1');
    assert.equal(out.principal.role, 'owner');
  } finally {
    if (prev === undefined) delete process.env.SCOPE_JWT_SECRET; else process.env.SCOPE_JWT_SECRET = prev;
  }
});

test('no credential => 401', async () => {
  const out = await run(hostedAuthMiddleware({ pool: null }), {});
  assert.equal(out.status, 401);
  assert.equal(out.body.error, 'unauthorized');
});

test('a garbage bearer token => 401', async () => {
  const prev = process.env.SCOPE_JWT_SECRET;
  process.env.SCOPE_JWT_SECRET = 's'.repeat(32);
  try {
    const out = await run(hostedAuthMiddleware({ pool: null }), {
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    assert.equal(out.status, 401);
  } finally {
    if (prev === undefined) delete process.env.SCOPE_JWT_SECRET; else process.env.SCOPE_JWT_SECRET = prev;
  }
});

test('API key: a valid sk_ key authenticates against the pool', async () => {
  const { plaintext, id, hash } = generateKey();
  // Fake pool: returns the stored api_keys row for this id, and swallows the
  // best-effort last_used_at update.
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('SELECT')) {
        assert.equal(params[0], id);
        return { rows: [{ id, account_id: 'acct_k', key_hash: hash, tenant_id: 'tnt_k', revoked_at: null }] };
      }
      return { rows: [] };
    },
  };
  const out = await run(hostedAuthMiddleware({ pool }), {
    headers: { authorization: `Bearer ${plaintext}` },
  });
  assert.ok(out.next, 'api key passed the gate');
  assert.equal(out.principal.accountId, 'acct_k');
  assert.equal(out.principal.kind, 'apikey');
  assert.equal(out.principal.tenantId, 'tnt_k');
});

test('API key: a revoked key => 401', async () => {
  const { plaintext, id, hash } = generateKey();
  const pool = {
    async query() {
      return { rows: [{ id, account_id: 'acct_k', key_hash: hash, tenant_id: null, revoked_at: '2020-01-01' }] };
    },
  };
  const out = await run(hostedAuthMiddleware({ pool }), {
    headers: { authorization: `Bearer ${plaintext}` },
  });
  assert.equal(out.status, 401);
});
