/**
 * OIDC authorization-code login (SCP-129) — GitHub / Google / Apple, driven by
 * env. No external dependency: discovery + token exchange use global `fetch`
 * (Node >= 18). PKCE + a signed `state` defend the redirect.
 *
 * Env:
 *   SCOPE_OIDC_ISSUER        e.g. https://accounts.google.com
 *   SCOPE_OIDC_CLIENT_ID
 *   SCOPE_OIDC_CLIENT_SECRET
 *   SCOPE_OIDC_REDIRECT      e.g. https://app.scope.dev/auth/callback
 *   SCOPE_OIDC_SCOPE         optional; default "openid email profile"
 *
 * Flow (ADR 0003 §1, principal = human):
 *   1. buildAuthUrl()  -> { url, state, codeVerifier } ; redirect the browser,
 *      stash state+verifier in a short-lived cookie/session.
 *   2. provider redirects back with ?code&state.
 *   3. handleCallback({ code, state, expectedState, codeVerifier }) -> exchanges
 *      the code at the token endpoint, decodes the id_token, returns the human
 *      identity { email, name, provider, providerSub }. The caller then
 *      upsertAccount (membership.js) + mints a session (sessions.js).
 *
 * VERIFIABILITY: steps 1 and the id_token DECODE are unit-testable offline.
 * The provider round-trip in step 3 (discovery + token POST) CANNOT be verified
 * here without a live OIDC provider; it is marked unverifiable and exercised
 * only via an injectable `fetchImpl` in tests with a stub.
 */
import { randomBytes, createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { isIP } from 'node:net';

function env(name, fallback = undefined) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

/* ----------------------------- SSRF guard (SCP-216) ----------------------- */

/**
 * Reject outbound URLs that could be abused for SSRF (SCP-216). The OIDC issuer
 * is operator-config today, so this is defense-in-depth: a misconfigured or
 * malicious issuer must not let us fetch internal services (cloud metadata,
 * loopback, RFC-1918, link-local). We require http(s) and BLOCK hosts that are
 * IP literals in private/loopback/link-local ranges, plus the well-known
 * `localhost` / `metadata.google.internal` names. Hostname-based DNS-rebinding
 * is explicitly out of scope here (literal-IP + localhost blocking is the ask).
 *
 * @param {string} u - the absolute URL about to be fetched
 * @throws {Error} when the URL scheme or host is disallowed
 */
function assertSafeHttpUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { throw new Error(`OIDC: refusing to fetch malformed URL: ${u}`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`OIDC: refusing non-http(s) URL: ${parsed.protocol}`);
  }
  // Strip IPv6 brackets so net.isIP / range checks see the bare address.
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === 'metadata.google.internal') {
    throw new Error(`OIDC: refusing to fetch internal host: ${host}`);
  }
  const kind = isIP(host);
  if (kind === 4 && isPrivateIPv4(host)) {
    throw new Error(`OIDC: refusing to fetch private/loopback address: ${host}`);
  }
  if (kind === 6 && isPrivateIPv6(host)) {
    throw new Error(`OIDC: refusing to fetch private/loopback address: ${host}`);
  }
}

function isPrivateIPv4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (o[0] === 127) return true;                                   // 127.0.0.0/8 loopback
  if (o[0] === 10) return true;                                    // 10.0.0.0/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;       // 172.16.0.0/12
  if (o[0] === 192 && o[1] === 168) return true;                   // 192.168.0.0/16
  if (o[0] === 169 && o[1] === 254) return true;                   // 169.254.0.0/16 link-local
  return false;
}

function isPrivateIPv6(ip) {
  const a = ip.toLowerCase();
  if (a === '::1') return true;                                    // loopback
  if (a.startsWith('fc') || a.startsWith('fd')) return true;       // fc00::/7 unique-local
  if (a.startsWith('fe80')) return true;                           // fe80::/10 link-local
  // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4.
  const m = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isPrivateIPv4(m[1]);
  return false;
}

export function oidcConfigured() {
  return !!(env('SCOPE_OIDC_ISSUER') && env('SCOPE_OIDC_CLIENT_ID') && env('SCOPE_OIDC_REDIRECT'));
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE S256 challenge from a verifier. */
function pkceChallenge(verifier) {
  return b64url(createHash('sha256').update(verifier).digest());
}

/**
 * Build the authorization-code redirect URL with PKCE + state. Pure (no
 * network): the well-known authorize endpoint is `${issuer}/authorize` unless
 * overridden, but most providers expose it via discovery — we keep buildAuthUrl
 * offline by allowing an explicit `authorizationEndpoint` override (the caller
 * can pass the discovered value).
 *
 * SCP-207: also generates a `nonce`, includes it in the auth request, and
 * returns it so the caller can stash it and assert it back in the id_token.
 *
 * @returns {{ url: string, state: string, codeVerifier: string, nonce: string }}
 */
export function buildAuthUrl({ issuer, clientId, redirectUri, scope, authorizationEndpoint } = {}) {
  issuer = issuer || env('SCOPE_OIDC_ISSUER');
  clientId = clientId || env('SCOPE_OIDC_CLIENT_ID');
  redirectUri = redirectUri || env('SCOPE_OIDC_REDIRECT');
  scope = scope || env('SCOPE_OIDC_SCOPE', 'openid email profile');
  if (!issuer || !clientId || !redirectUri) {
    throw new Error('OIDC not configured: set SCOPE_OIDC_ISSUER/CLIENT_ID/REDIRECT');
  }
  const state = b64url(randomBytes(16));
  const codeVerifier = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(16)); // SCP-207: replay-binds the id_token
  const endpoint = authorizationEndpoint || `${issuer.replace(/\/$/, '')}/authorize`;
  const u = new URL(endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
  u.searchParams.set('code_challenge_method', 'S256');
  return { url: u.toString(), state, codeVerifier, nonce };
}

/** Decode (NOT verify) a JWT id_token's claims. Offline-testable. */
export function decodeIdToken(idToken) {
  if (typeof idToken !== 'string') throw new Error('id_token must be a string');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const payload = JSON.parse(
    Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  );
  return payload;
}

/* ----------------------- id_token verification (SCP-207) ------------------ */

// Map JOSE alg -> { isSymmetric, the crypto.verify config }. We deliberately
// support only RS256 + ES256 and NEVER accept `none` or any HS* (symmetric)
// alg: an id_token must be asymmetrically signed by the provider, otherwise an
// attacker who knows the (public) client_secret-ish material could forge one.
const ALG = {
  RS256: { hash: 'sha256', dsaEncoding: undefined },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' }, // raw JOSE r||s sig
};

function b64urlJson(seg) {
  return JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

/**
 * Cryptographically verify an OIDC id_token (SCP-207). Before this, handleCallback
 * DECODED the token without checking its signature or claims — anyone able to
 * sit on the token response (or replay one) could forge an identity. This:
 *   - parses the JWT header, requires alg in {RS256, ES256} (rejects `none`/HS*),
 *   - fetches the JWKS, finds the signing key by `kid`, imports it as a public
 *     key, and verifies the signature over the JOSE signing input `header.payload`,
 *   - asserts iss === issuer, aud includes clientId, exp/iat within skew, and
 *     (when provided) nonce === claims.nonce.
 *
 * @param {string} idToken
 * @param {object} opts
 * @param {string} opts.issuer
 * @param {string} opts.clientId
 * @param {string} opts.jwksUri      - discovered jwks_uri
 * @param {string} [opts.nonce]      - the nonce we issued in buildAuthUrl
 * @param {function} [opts.fetchImpl] - injectable for tests (default global fetch)
 * @param {number} [opts.now]        - epoch ms override for tests
 * @returns {Promise<object>} the verified claims
 * @throws {Error} on any signature or claim failure
 */
export async function verifyIdToken(idToken, { issuer, clientId, jwksUri, nonce, fetchImpl = fetch, now } = {}) {
  if (typeof idToken !== 'string') throw new Error('id_token must be a string');
  if (!issuer || !clientId || !jwksUri) throw new Error('verifyIdToken needs issuer, clientId, jwksUri');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const [h, p, s] = parts;

  const header = b64urlJson(h);
  const alg = header.alg;
  if (alg === 'none') throw new Error('id_token alg "none" is not allowed');
  if (typeof alg !== 'string' || !ALG[alg]) {
    throw new Error(`id_token alg not allowed: ${alg} (only RS256/ES256)`);
  }

  // Fetch the JWKS (SSRF-guarded) and pick the key by kid.
  assertSafeHttpUrl(jwksUri);
  const jwksRes = await fetchImpl(jwksUri);
  if (!jwksRes.ok) throw new Error(`JWKS fetch failed: ${jwksRes.status}`);
  const jwks = await jwksRes.json();
  const keys = Array.isArray(jwks && jwks.keys) ? jwks.keys : [];
  let jwk = header.kid ? keys.find((k) => k.kid === header.kid) : null;
  // Fall back to a sole key if the token omits kid (some providers do).
  if (!jwk && keys.length === 1) jwk = keys[0];
  if (!jwk) throw new Error(`no JWKS key matched kid=${header.kid}`);

  const pub = createPublicKey({ key: jwk, format: 'jwk' });
  const cfg = ALG[alg];
  const signingInput = Buffer.from(`${h}.${p}`);
  const sig = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const keyArg = cfg.dsaEncoding ? { key: pub, dsaEncoding: cfg.dsaEncoding } : pub;
  const ok = cryptoVerify(cfg.hash, signingInput, keyArg, sig);
  if (!ok) throw new Error('id_token signature verification failed');

  // Signature is good — now the claims.
  const claims = b64urlJson(p);
  if (claims.iss !== issuer) throw new Error(`id_token iss mismatch: ${claims.iss}`);
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(clientId) : aud === clientId;
  if (!audOk) throw new Error('id_token aud does not include clientId');

  const nowSec = Math.floor((now ?? Date.now()) / 1000);
  const SKEW = 120; // seconds of allowed clock skew
  if (typeof claims.exp !== 'number' || claims.exp <= nowSec) throw new Error('id_token expired');
  if (typeof claims.iat === 'number' && claims.iat > nowSec + SKEW) throw new Error('id_token iat in the future');
  if (nonce != null && claims.nonce !== nonce) throw new Error('id_token nonce mismatch');

  return claims;
}

/** Map raw id_token claims to our identity shape (provider = issuer host). */
export function identityFromClaims(claims, { provider } = {}) {
  if (!claims || !claims.sub) throw new Error('id_token missing sub');
  return {
    provider: provider || hostOf(claims.iss),
    providerSub: claims.sub,
    email: claims.email || null,
    name: claims.name || claims.preferred_username || null,
    emailVerified: claims.email_verified ?? null,
  };
}

function hostOf(iss) {
  try { return new URL(iss).host; } catch { return iss || null; }
}

/**
 * Fetch the provider's discovery document (.well-known/openid-configuration).
 * UNVERIFIABLE without a live provider; `fetchImpl` is injectable for tests.
 */
export async function discover(issuer = env('SCOPE_OIDC_ISSUER'), { fetchImpl = fetch } = {}) {
  if (!issuer) throw new Error('OIDC issuer not configured');
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  assertSafeHttpUrl(url); // SCP-216 SSRF guard
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  return res.json();
}

/**
 * Exchange an authorization code for tokens, then decode the id_token into our
 * identity shape. The token POST is the part that NEEDS a live provider.
 *
 * @param {object} args
 * @param {string} args.code
 * @param {string} args.state - the state echoed back by the provider
 * @param {string} args.expectedState - the state we issued in buildAuthUrl
 * @param {string} args.codeVerifier - the PKCE verifier we issued
 * @param {string} [args.tokenEndpoint] - discovered token endpoint (else derived)
 * @param {string} [args.jwksUri]   - discovered jwks_uri (SCP-207, required to verify)
 * @param {string} [args.nonce]     - the nonce we issued in buildAuthUrl (SCP-207)
 * @param {function} [args.fetchImpl] - injectable for tests (default global fetch)
 * @returns {Promise<{ identity: object, tokens: object }>}
 */
export async function handleCallback({
  code, state, expectedState, codeVerifier,
  issuer, clientId, clientSecret, redirectUri, tokenEndpoint, jwksUri, nonce, fetchImpl = fetch,
} = {}) {
  if (!state || !expectedState || state !== expectedState) {
    const err = new Error('OIDC state mismatch (possible CSRF)');
    err.code = 'OIDC_STATE';
    throw err;
  }
  if (!code) throw new Error('OIDC callback missing code');

  issuer = issuer || env('SCOPE_OIDC_ISSUER');
  clientId = clientId || env('SCOPE_OIDC_CLIENT_ID');
  clientSecret = clientSecret || env('SCOPE_OIDC_CLIENT_SECRET');
  redirectUri = redirectUri || env('SCOPE_OIDC_REDIRECT');
  const endpoint = tokenEndpoint || `${issuer.replace(/\/$/, '')}/token`;
  assertSafeHttpUrl(endpoint); // SCP-216 SSRF guard

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier || '',
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  // --- provider round-trip (UNVERIFIABLE without a real provider) ---
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OIDC token exchange failed: ${res.status} ${text}`);
  }
  const tokens = await res.json();
  if (!tokens.id_token) throw new Error('OIDC token response missing id_token');

  // SCP-207: VERIFY the id_token (signature + iss/aud/exp/iat/nonce) before
  // trusting any of its claims. jwks_uri comes from the discovery doc; the
  // caller must thread it (and the issued nonce) through.
  const resolvedJwksUri = jwksUri || `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  const claims = await verifyIdToken(tokens.id_token, {
    issuer, clientId, jwksUri: resolvedJwksUri, nonce, fetchImpl,
  });
  const identity = identityFromClaims(claims, { provider: hostOf(issuer) });
  return { identity, tokens };
}
