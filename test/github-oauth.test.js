import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGithubAuthUrl, identityFromGithubUser, handleGithubCallback, githubConfigured,
} from '../src/auth_hosted/github.js';

/**
 * SCP-169 — GitHub OAuth adapter. GitHub is OAuth2 (no id_token), so it has its
 * own flow. The URL build + identity mapping are pure/offline; the callback's
 * two network calls take an injectable fetchImpl, stubbed here.
 */

test('buildGithubAuthUrl emits client_id, redirect, scope, and a state', () => {
  const { url, state } = buildGithubAuthUrl({
    clientId: 'cid', redirectUri: 'https://h/auth/callback', scope: 'read:user user:email',
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://h/auth/callback');
  assert.equal(u.searchParams.get('scope'), 'read:user user:email');
  assert.ok(state && u.searchParams.get('state') === state, 'state is echoed into the URL');
});

test('SCP-208: buildGithubAuthUrl emits a PKCE S256 challenge and returns a codeVerifier', async () => {
  const { url, codeVerifier } = buildGithubAuthUrl({
    clientId: 'cid', redirectUri: 'https://h/auth/callback',
  });
  assert.ok(codeVerifier && typeof codeVerifier === 'string', 'returns a codeVerifier');
  const u = new URL(url);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const challenge = u.searchParams.get('code_challenge');
  assert.ok(challenge, 'code_challenge present in the URL');
  // The challenge must be the S256 hash of the verifier (RFC 7636).
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(codeVerifier).digest()
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected, 'challenge is S256(verifier)');
});

test('identityFromGithubUser maps to the human identity shape', () => {
  const id = identityFromGithubUser({ id: 42, login: 'bri', name: 'Bri' }, 'bri@x.com', true);
  assert.deepEqual(id, {
    provider: 'github', providerSub: '42', email: 'bri@x.com', name: 'Bri', emailVerified: true,
  });
});

test('handleGithubCallback exchanges the code and resolves identity (stubbed fetch)', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.includes('/login/oauth/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'gho_test', token_type: 'bearer' }) };
    }
    if (url === 'https://api.github.com/user') {
      return { ok: true, json: async () => ({ id: 99, login: 'octo', name: 'Octo Cat', email: null }) };
    }
    if (url === 'https://api.github.com/user/emails') {
      return { ok: true, json: async () => ([{ email: 'octo@github.com', primary: true, verified: true }]) };
    }
    throw new Error('unexpected url ' + url);
  };
  const { identity } = await handleGithubCallback({
    code: 'abc', state: 's1', expectedState: 's1',
    clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://h/cb', fetchImpl,
  });
  assert.deepEqual(identity, {
    provider: 'github', providerSub: '99', email: 'octo@github.com', name: 'Octo Cat', emailVerified: true,
  });
  assert.ok(calls.some((u) => u.includes('access_token')), 'did the token exchange');
});

test('SCP-208: handleGithubCallback forwards code_verifier in the token POST', async () => {
  let tokenBody = null;
  const fetchImpl = async (url, opts) => {
    if (url.includes('/login/oauth/access_token')) {
      tokenBody = new URLSearchParams(opts.body);
      return { ok: true, json: async () => ({ access_token: 'gho_test', token_type: 'bearer' }) };
    }
    if (url === 'https://api.github.com/user') {
      return { ok: true, json: async () => ({ id: 7, login: 'pk', name: 'PK' }) };
    }
    if (url === 'https://api.github.com/user/emails') {
      return { ok: true, json: async () => ([{ email: 'pk@x.com', primary: true, verified: true }]) };
    }
    throw new Error('unexpected url ' + url);
  };
  await handleGithubCallback({
    code: 'abc', state: 's1', expectedState: 's1', codeVerifier: 'verifier-xyz',
    clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://h/cb', fetchImpl,
  });
  assert.ok(tokenBody, 'token exchange happened');
  assert.equal(tokenBody.get('code_verifier'), 'verifier-xyz', 'PKCE verifier sent to GitHub');
});

test('handleGithubCallback rejects a state mismatch before any network call', async () => {
  let fetched = false;
  await assert.rejects(
    () => handleGithubCallback({
      code: 'abc', state: 'evil', expectedState: 'good',
      fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({}) }; },
    }),
    (e) => e.code === 'OIDC_STATE'
  );
  assert.equal(fetched, false, 'no token exchange on a bad state (CSRF defense)');
});

test('githubConfigured reflects the env', () => {
  const saved = ['SCOPE_GITHUB_CLIENT_ID', 'SCOPE_GITHUB_CLIENT_SECRET', 'SCOPE_GITHUB_REDIRECT']
    .map((k) => [k, process.env[k]]);
  try {
    for (const [k] of saved) delete process.env[k];
    assert.equal(githubConfigured(), false);
    process.env.SCOPE_GITHUB_CLIENT_ID = 'a';
    process.env.SCOPE_GITHUB_CLIENT_SECRET = 'b';
    process.env.SCOPE_GITHUB_REDIRECT = 'https://h/cb';
    assert.equal(githubConfigured(), true);
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
