import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import {
  verifyIdToken, buildAuthUrl, discover, handleCallback,
} from '../src/auth_hosted/oidc.js';

/**
 * SCP-207 — the OIDC id_token was DECODED but never VERIFIED. These tests mint
 * real RS256/ES256/HS256 tokens with node:crypto, serve the JWK via a stub
 * fetchImpl, and assert verifyIdToken accepts a valid token and rejects every
 * forgery/tamper/claim failure. SCP-216 — the SSRF guard is exercised via the
 * outbound fetches (discover/token/jwks reject private + localhost hosts).
 */

const ISSUER = 'https://accounts.google.com';
const CLIENT_ID = 'client-123';
const JWKS_URI = 'https://accounts.google.com/jwks';

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Mint a signed JWT. `alg` selects the signing config; `tamper` flips the sig. */
function mintJwt({ alg, privateKey, header = {}, claims, raw, tamper = false }) {
  const h = b64url(JSON.stringify({ alg, typ: 'JWT', ...header }));
  const p = b64url(JSON.stringify(claims));
  const signingInput = `${h}.${p}`;
  let sig;
  if (alg === 'none') {
    sig = '';
  } else if (alg === 'RS256') {
    sig = b64url(cryptoSign('sha256', Buffer.from(signingInput), privateKey));
  } else if (alg === 'ES256') {
    sig = b64url(cryptoSign('sha256', Buffer.from(signingInput), { key: privateKey, dsaEncoding: 'ieee-p1363' }));
  } else if (alg === 'HS256') {
    // HS256 needs a shared secret; verifyIdToken must reject the alg regardless.
    const { createHmac } = raw;
    sig = b64url(createHmac('sha256', 'shhh').update(signingInput).digest());
  }
  if (tamper && sig) {
    // Flip a character in the signature to corrupt it (keep it base64url-valid).
    const flipped = sig[0] === 'A' ? 'B' : 'A';
    sig = flipped + sig.slice(1);
  }
  return `${h}.${p}`.concat('.', sig);
}

/** A stub fetchImpl that serves the given JWKS at JWKS_URI. */
function jwksFetch(jwk) {
  return async (url) => {
    if (url === JWKS_URI) {
      return { ok: true, json: async () => ({ keys: [jwk] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

function validClaims(extra = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return { iss: ISSUER, aud: CLIENT_ID, sub: 'user-1', exp: nowSec + 600, iat: nowSec, ...extra };
}

/* ------------------------------- happy path ------------------------------- */

test('verifyIdToken accepts a valid RS256 id_token', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({ alg: 'RS256', privateKey, header: { kid: 'rs1' }, claims: validClaims() });
  const claims = await verifyIdToken(token, {
    issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk),
  });
  assert.equal(claims.sub, 'user-1');
});

test('verifyIdToken accepts a valid ES256 id_token (raw r||s sig)', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'es1' };
  const token = mintJwt({ alg: 'ES256', privateKey, header: { kid: 'es1' }, claims: validClaims() });
  const claims = await verifyIdToken(token, {
    issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk),
  });
  assert.equal(claims.sub, 'user-1');
});

test('verifyIdToken accepts aud given as an array including clientId', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({
    alg: 'RS256', privateKey, header: { kid: 'rs1' },
    claims: validClaims({ aud: ['other', CLIENT_ID] }),
  });
  const claims = await verifyIdToken(token, {
    issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk),
  });
  assert.equal(claims.sub, 'user-1');
});

test('verifyIdToken accepts a matching nonce', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({
    alg: 'RS256', privateKey, header: { kid: 'rs1' }, claims: validClaims({ nonce: 'n-abc' }),
  });
  const claims = await verifyIdToken(token, {
    issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, nonce: 'n-abc', fetchImpl: jwksFetch(jwk),
  });
  assert.equal(claims.nonce, 'n-abc');
});

/* ------------------------------- rejections ------------------------------- */

test('verifyIdToken REJECTS a tampered/wrong signature', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({ alg: 'RS256', privateKey, header: { kid: 'rs1' }, claims: validClaims(), tamper: true });
  await assert.rejects(
    () => verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk) }),
    /signature verification failed/
  );
});

test('verifyIdToken REJECTS a signature made by a different key', async () => {
  const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const honest = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...honest.publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  // Signed by the attacker's key, but JWKS only serves the honest public key.
  const token = mintJwt({ alg: 'RS256', privateKey: attacker.privateKey, header: { kid: 'rs1' }, claims: validClaims() });
  await assert.rejects(
    () => verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk) }),
    /signature verification failed/
  );
});

test('verifyIdToken REJECTS alg:none', async () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({ alg: 'none', header: { kid: 'rs1' }, claims: validClaims() });
  await assert.rejects(
    () => verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk) }),
    /alg "none" is not allowed/
  );
});

test('verifyIdToken REJECTS an HS256 (symmetric) token', async () => {
  const { createHmac } = await import('node:crypto');
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({ alg: 'HS256', header: { kid: 'rs1' }, claims: validClaims(), raw: { createHmac } });
  await assert.rejects(
    () => verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk) }),
    /alg not allowed: HS256/
  );
});

test('verifyIdToken REJECTS a wrong issuer', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({ alg: 'RS256', privateKey, header: { kid: 'rs1' }, claims: validClaims({ iss: 'https://evil.example' }) });
  await assert.rejects(
    () => verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk) }),
    /iss mismatch/
  );
});

test('verifyIdToken REJECTS a wrong audience', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({ alg: 'RS256', privateKey, header: { kid: 'rs1' }, claims: validClaims({ aud: 'someone-else' }) });
  await assert.rejects(
    () => verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk) }),
    /aud does not include clientId/
  );
});

test('verifyIdToken REJECTS an expired token', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const nowSec = Math.floor(Date.now() / 1000);
  const token = mintJwt({ alg: 'RS256', privateKey, header: { kid: 'rs1' }, claims: validClaims({ exp: nowSec - 10 }) });
  await assert.rejects(
    () => verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, fetchImpl: jwksFetch(jwk) }),
    /expired/
  );
});

test('verifyIdToken REJECTS a nonce mismatch', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({ alg: 'RS256', privateKey, header: { kid: 'rs1' }, claims: validClaims({ nonce: 'real' }) });
  await assert.rejects(
    () => verifyIdToken(token, { issuer: ISSUER, clientId: CLIENT_ID, jwksUri: JWKS_URI, nonce: 'expected', fetchImpl: jwksFetch(jwk) }),
    /nonce mismatch/
  );
});

/* ----------------------- buildAuthUrl emits a nonce ----------------------- */

test('buildAuthUrl generates a nonce and includes it in the URL', () => {
  const { url, state, codeVerifier, nonce } = buildAuthUrl({
    issuer: ISSUER, clientId: CLIENT_ID, redirectUri: 'https://app/cb',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  });
  assert.ok(state && codeVerifier && nonce, 'returns state, verifier, nonce');
  const u = new URL(url);
  assert.equal(u.searchParams.get('nonce'), nonce, 'nonce echoed into the auth URL');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
});

/* ----------- handleCallback verifies the id_token end-to-end -------------- */

test('handleCallback verifies the id_token via verifyIdToken (stubbed provider)', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const idToken = mintJwt({
    alg: 'RS256', privateKey, header: { kid: 'rs1' },
    claims: validClaims({ email: 'u@x.com', email_verified: true, nonce: 'nn' }),
  });
  const fetchImpl = async (url, opts) => {
    if (opts && opts.method === 'POST') {
      return { ok: true, json: async () => ({ id_token: idToken }) };
    }
    if (url === JWKS_URI) return { ok: true, json: async () => ({ keys: [jwk] }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  const { identity } = await handleCallback({
    code: 'c', state: 's', expectedState: 's', codeVerifier: 'v',
    issuer: ISSUER, clientId: CLIENT_ID, redirectUri: 'https://app/cb',
    tokenEndpoint: 'https://accounts.google.com/token', jwksUri: JWKS_URI, nonce: 'nn', fetchImpl,
  });
  assert.equal(identity.email, 'u@x.com');
  assert.equal(identity.emailVerified, true);
});

test('handleCallback rejects when the id_token nonce does not match', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const idToken = mintJwt({ alg: 'RS256', privateKey, header: { kid: 'rs1' }, claims: validClaims({ nonce: 'real' }) });
  const fetchImpl = async (url, opts) => {
    if (opts && opts.method === 'POST') return { ok: true, json: async () => ({ id_token: idToken }) };
    if (url === JWKS_URI) return { ok: true, json: async () => ({ keys: [jwk] }) };
    throw new Error(`unexpected fetch ${url}`);
  };
  await assert.rejects(
    () => handleCallback({
      code: 'c', state: 's', expectedState: 's', codeVerifier: 'v',
      issuer: ISSUER, clientId: CLIENT_ID, redirectUri: 'https://app/cb',
      tokenEndpoint: 'https://accounts.google.com/token', jwksUri: JWKS_URI, nonce: 'WRONG', fetchImpl,
    }),
    /nonce mismatch/
  );
});

/* --------------------------- SSRF guard (SCP-216) ------------------------- */

test('SSRF guard rejects the cloud metadata IP, localhost, and RFC-1918', async () => {
  // discover() runs assertSafeHttpUrl before any fetch; a blocked issuer throws
  // synchronously-ish (before the stub fetch is ever called).
  const neverFetch = async () => { throw new Error('fetch should not be reached'); };
  for (const issuer of ['http://169.254.169.254', 'http://localhost', 'http://10.0.0.5', 'http://192.168.1.1', 'http://[::1]']) {
    await assert.rejects(
      () => discover(issuer, { fetchImpl: neverFetch }),
      /refusing to fetch/,
      `should block ${issuer}`
    );
  }
});

test('SSRF guard allows a normal https issuer', async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; return { ok: true, json: async () => ({ ok: 1 }) }; };
  const doc = await discover('https://accounts.google.com', { fetchImpl });
  assert.ok(fetched, 'fetch was reached for an allowed host');
  assert.deepEqual(doc, { ok: 1 });
});

test('SSRF guard blocks a jwks_uri that resolves to a private literal', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'rs1' };
  const token = mintJwt({ alg: 'RS256', privateKey, header: { kid: 'rs1' }, claims: validClaims() });
  await assert.rejects(
    () => verifyIdToken(token, {
      issuer: ISSUER, clientId: CLIENT_ID, jwksUri: 'http://169.254.169.254/jwks',
      fetchImpl: jwksFetch(jwk),
    }),
    /refusing to fetch/
  );
});
