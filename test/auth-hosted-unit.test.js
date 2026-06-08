import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mintAccessToken, verifyAccessToken,
  issueRefreshToken, parseRefreshToken, checkRefreshRow,
} from '../src/auth_hosted/sessions.js';
import { generateKey, hashKey, verifyKey, parseKey } from '../src/auth_hosted/apikeys.js';
import { roleSatisfies } from '../src/auth_hosted/membership.js';
import { authorizeUploadActors, authorizeUpload, statusForReject } from '../src/auth_hosted/authz.js';
import { buildAuthUrl, decodeIdToken, identityFromClaims, handleCallback } from '../src/auth_hosted/oidc.js';

const SECRET = 'test-jwt-secret-0123456789abcdef';

/* ----------------------------- SCP-129 JWT ------------------------------ */

test('mint/verify round-trips claims incl. sub + project/role', () => {
  const tok = mintAccessToken({ sub: 'acct_1', tenant_id: 'tnt_a', role: 'member' }, { secret: SECRET });
  const claims = verifyAccessToken(tok, { secret: SECRET });
  assert.equal(claims.sub, 'acct_1');
  assert.equal(claims.tenant_id, 'tnt_a');
  assert.equal(claims.role, 'member');
  assert.equal(typeof claims.iat, 'number');
  assert.equal(typeof claims.exp, 'number');
});

test('mint requires sub', () => {
  assert.throws(() => mintAccessToken({}, { secret: SECRET }), /sub/);
});

test('verify rejects a tampered payload', () => {
  const tok = mintAccessToken({ sub: 'acct_1' }, { secret: SECRET });
  const [h, , s] = tok.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'acct_admin', exp: 9e9 })).toString('base64url')}.${s}`;
  assert.throws(() => verifyAccessToken(forged, { secret: SECRET }), /bad signature/);
});

test('verify rejects wrong secret', () => {
  const tok = mintAccessToken({ sub: 'acct_1' }, { secret: SECRET });
  assert.throws(() => verifyAccessToken(tok, { secret: 'a-totally-different-secret-xxxxx' }), /bad signature/);
});

test('verify rejects alg=none / algorithm confusion', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'acct_admin', exp: 9e9 })).toString('base64url');
  assert.throws(() => verifyAccessToken(`${header}.${payload}.`, { secret: SECRET }), /unsupported alg/);
});

test('verify rejects an expired token', () => {
  const tok = mintAccessToken({ sub: 'acct_1' }, { secret: SECRET, ttlSeconds: 60, now: 1000 });
  assert.throws(() => verifyAccessToken(tok, { secret: SECRET, now: 2000 }), /expired/);
  // still valid before exp
  const claims = verifyAccessToken(tok, { secret: SECRET, now: 1030 });
  assert.equal(claims.sub, 'acct_1');
});

test('verify rejects malformed tokens', () => {
  assert.throws(() => verifyAccessToken('not.a', { secret: SECRET }), /malformed/);
  assert.throws(() => verifyAccessToken(123, { secret: SECRET }), /string/);
});

/* ------------------------- SCP-129 refresh tokens ----------------------- */

test('refresh token issue stores only a hash; plaintext verifies', () => {
  const { token, row } = issueRefreshToken('acct_1', { now: 0 });
  assert.match(token, /^rt_[0-9a-f]+\.[0-9a-f]+$/);
  assert.ok(!row.token_hash.includes(token.split('.')[1]), 'hash is not the secret');
  const { id, hash } = parseRefreshToken(token);
  assert.equal(id, row.id);
  assert.deepEqual(checkRefreshRow(row, hash, { now: 1000 }), { ok: true });
});

test('refresh check rejects expired / revoked / rotated(reuse) / unknown', () => {
  const { token, row } = issueRefreshToken('acct_1', { ttlDays: 1, now: 0 });
  const { hash } = parseRefreshToken(token);
  assert.equal(checkRefreshRow(row, hash, { now: 2 * 86400_000 }).reason, 'refresh token expired');
  assert.equal(checkRefreshRow({ ...row, revoked_at: 'x' }, hash, { now: 1 }).reason, 'refresh token revoked');
  const reuse = checkRefreshRow({ ...row, rotated_to: 'rt_next' }, hash, { now: 1 });
  assert.equal(reuse.reuse, true);
  assert.equal(checkRefreshRow(null, hash).reason, 'unknown refresh token');
  assert.equal(checkRefreshRow(row, 'deadbeef', { now: 1 }).reason, 'unknown refresh token');
});

/* ------------------------------ SCP-130 keys ---------------------------- */

test('generate -> hash -> verify; plaintext never equals stored hash', () => {
  const { plaintext, id, hash } = generateKey();
  assert.match(plaintext, /^sk_[0-9a-f]+\.[0-9a-f]+$/);
  assert.equal(parseKey(plaintext).id, id);
  assert.notEqual(hash, plaintext, 'hash != plaintext');
  assert.ok(!plaintext.includes(hash), 'plaintext does not contain the hash');
  assert.equal(verifyKey(plaintext, hash), true);
});

test('verifyKey rejects a wrong key and a wrong hash', () => {
  const a = generateKey();
  const b = generateKey();
  assert.equal(verifyKey(b.plaintext, a.hash), false);
  assert.equal(verifyKey(a.plaintext, 'not-the-hash'), false);
  assert.equal(verifyKey('garbage', a.hash), false);
});

test('hashKey is stable and matches on the secret half only', () => {
  const { plaintext } = generateKey();
  assert.equal(hashKey(plaintext), hashKey(plaintext));
  assert.equal(hashKey(plaintext), hashKey(parseKey(plaintext).secret));
});

/* --------------------------- SCP-131 role logic ------------------------- */

test('roleSatisfies enforces owner>member>viewer; unknown never passes', () => {
  assert.equal(roleSatisfies('owner', 'member'), true);
  assert.equal(roleSatisfies('member', 'member'), true);
  assert.equal(roleSatisfies('viewer', 'member'), false);
  assert.equal(roleSatisfies('owner', 'viewer'), true);
  assert.equal(roleSatisfies(null, 'viewer'), false);
  assert.equal(roleSatisfies('owner', 'bogus'), false);
  assert.equal(roleSatisfies('bogus', 'viewer'), false);
});

/* --------------------------- SCP-132 upload authz ----------------------- */

const evt = (actor, model) => ({ id: 'E1', actor, ...(model ? { model } : {}) });

test('authorize accepts when every actor == principal', () => {
  const events = [evt('bri'), { id: 'E2', actor: 'bri', model: 'Opus 4.8' }];
  assert.deepEqual(authorizeUploadActors(events, 'bri'), { ok: true });
});

test('authorize rejects an actor that differs from the principal', () => {
  const r = authorizeUploadActors([evt('mallory')], 'bri');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ACTOR_MISMATCH');
  assert.equal(r.eventId, 'E1');
});

test('authorize rejects a rendered "{model} on behalf of {user}" smuggled into actor', () => {
  // The model is metadata; the raw actor must be the bare principal. A client
  // putting the display string in `actor` is an impersonation attempt.
  const r = authorizeUploadActors([evt('Opus 4.8 on behalf of bri')], 'bri');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ACTOR_RENDERED');
});

test('authorize rejects missing actor and missing principal', () => {
  assert.equal(authorizeUploadActors([{ id: 'E1' }], 'bri').code, 'ACTOR_MISSING');
  assert.equal(authorizeUploadActors([evt('bri')], '').code, 'PRINCIPAL_MISSING');
  assert.equal(authorizeUploadActors([evt('bri')], 'a on behalf of b').code, 'PRINCIPAL_MISSING');
});

test('authorizeUpload runs the role gate after the actor check', async () => {
  const events = [evt('bri')];
  assert.deepEqual(await authorizeUpload(events, 'bri', { checkRole: () => true }), { ok: true });
  const denied = await authorizeUpload(events, 'bri', { checkRole: async () => false });
  assert.equal(denied.code, 'FORBIDDEN_ROLE');
  // actor check short-circuits before role check
  const mismatch = await authorizeUpload([evt('x')], 'bri', { checkRole: () => true });
  assert.equal(mismatch.code, 'ACTOR_MISMATCH');
});

test('statusForReject maps codes to HTTP statuses', () => {
  assert.equal(statusForReject('PRINCIPAL_MISSING'), 401);
  assert.equal(statusForReject('FORBIDDEN_ROLE'), 403);
  assert.equal(statusForReject('ACTOR_MISMATCH'), 403);
});

/* ------------------------------ SCP-129 OIDC ---------------------------- */

test('buildAuthUrl emits code+PKCE+state (offline)', () => {
  const { url, state, codeVerifier } = buildAuthUrl({
    issuer: 'https://issuer.example', clientId: 'cid', redirectUri: 'https://app/cb',
    authorizationEndpoint: 'https://issuer.example/authorize',
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), state);
  assert.ok(u.searchParams.get('code_challenge'));
  assert.ok(codeVerifier.length > 20);
});

test('decodeIdToken + identityFromClaims map to the human identity shape', () => {
  const payload = Buffer.from(JSON.stringify({
    sub: 'gh|42', email: 'bri@x.com', name: 'Bri', iss: 'https://github.example',
  })).toString('base64url');
  const idToken = `h.${payload}.sig`;
  const id = identityFromClaims(decodeIdToken(idToken), { provider: 'github.example' });
  assert.equal(id.providerSub, 'gh|42');
  assert.equal(id.email, 'bri@x.com');
  assert.equal(id.provider, 'github.example');
});

test('handleCallback rejects a state mismatch before any network call', async () => {
  let called = false;
  await assert.rejects(
    () => handleCallback({ code: 'c', state: 'a', expectedState: 'b', fetchImpl: () => { called = true; } }),
    /state mismatch/
  );
  assert.equal(called, false, 'no token exchange attempted on CSRF');
});

test('handleCallback exchanges code via injected fetch (provider stubbed)', async () => {
  // Real provider round-trip is UNVERIFIABLE without a provider; this exercises
  // the exchange wiring with a stub so the parsing/decoding path is covered.
  const idToken = `h.${Buffer.from(JSON.stringify({ sub: 's1', email: 'e@x', iss: 'https://issuer.example' })).toString('base64url')}.sig`;
  const fetchImpl = async () => ({ ok: true, json: async () => ({ id_token: idToken, access_token: 'at' }) });
  const { identity, tokens } = await handleCallback({
    code: 'c', state: 's', expectedState: 's', codeVerifier: 'v',
    issuer: 'https://issuer.example', clientId: 'cid', redirectUri: 'https://app/cb', fetchImpl,
  });
  assert.equal(identity.providerSub, 's1');
  assert.equal(tokens.access_token, 'at');
});
