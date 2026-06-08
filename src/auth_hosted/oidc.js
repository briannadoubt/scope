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
import { randomBytes, createHash } from 'node:crypto';

function env(name, fallback = undefined) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
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
 * @returns {{ url: string, state: string, codeVerifier: string }}
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
  const endpoint = authorizationEndpoint || `${issuer.replace(/\/$/, '')}/authorize`;
  const u = new URL(endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
  u.searchParams.set('code_challenge_method', 'S256');
  return { url: u.toString(), state, codeVerifier };
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
 * @param {function} [args.fetchImpl] - injectable for tests (default global fetch)
 * @returns {Promise<{ identity: object, tokens: object }>}
 */
export async function handleCallback({
  code, state, expectedState, codeVerifier,
  issuer, clientId, clientSecret, redirectUri, tokenEndpoint, fetchImpl = fetch,
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
  const identity = identityFromClaims(decodeIdToken(tokens.id_token), { provider: hostOf(issuer) });
  return { identity, tokens };
}
