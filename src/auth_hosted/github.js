/**
 * GitHub OAuth2 login adapter (SCP-169).
 *
 * GitHub is NOT a standard OIDC provider for user sign-in: the web flow returns
 * an opaque OAuth access token, not an `id_token`, and there is no usable
 * `.well-known/openid-configuration` for it. So the generic OIDC module
 * (./oidc.js) can't drive GitHub — this adapter implements the GitHub-specific
 * authorize + token-exchange + identity-fetch, mapping the result onto the SAME
 * identity shape oidc.identityFromClaims produces, so the callback handler in
 * cloud-auth.js treats both providers uniformly.
 *
 * Env:
 *   SCOPE_GITHUB_CLIENT_ID
 *   SCOPE_GITHUB_CLIENT_SECRET
 *   SCOPE_GITHUB_REDIRECT      e.g. https://scope-hub.fly.dev/auth/callback
 *   SCOPE_GITHUB_SCOPE         optional; default "read:user user:email"
 *
 * Flow (mirrors oidc.js, ADR 0003 §1, principal = human):
 *   1. buildGithubAuthUrl()  -> { url, state }; redirect, stash state in a
 *      short-lived signed cookie.
 *   2. provider redirects back with ?code&state.
 *   3. handleGithubCallback({ code, state, expectedState }) -> exchanges the
 *      code for an access token, then GET /user (+ /user/emails) to build the
 *      identity { provider:'github', providerSub, email, name, emailVerified }.
 *
 * VERIFIABILITY: buildGithubAuthUrl and the identity mapping are unit-testable
 * offline. The two network round-trips (token POST, /user GET) need a live
 * provider; both take an injectable `fetchImpl` so tests stub them.
 */
import { randomBytes } from 'node:crypto';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';

function env(name, fallback = undefined) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

/** True when the GitHub OAuth app env is fully configured. */
export function githubConfigured() {
  return !!(env('SCOPE_GITHUB_CLIENT_ID') && env('SCOPE_GITHUB_CLIENT_SECRET') && env('SCOPE_GITHUB_REDIRECT'));
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the GitHub authorize redirect URL with an anti-CSRF `state`. Pure (no
 * network). Stash the returned `state` in a signed, short-lived cookie and
 * compare it on the callback.
 * @returns {{ url: string, state: string }}
 */
export function buildGithubAuthUrl({ clientId, redirectUri, scope } = {}) {
  clientId = clientId || env('SCOPE_GITHUB_CLIENT_ID');
  redirectUri = redirectUri || env('SCOPE_GITHUB_REDIRECT');
  scope = scope || env('SCOPE_GITHUB_SCOPE', 'read:user user:email');
  if (!clientId || !redirectUri) {
    throw new Error('GitHub OAuth not configured: set SCOPE_GITHUB_CLIENT_ID/REDIRECT');
  }
  const state = b64url(randomBytes(16));
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'true');
  return { url: u.toString(), state };
}

/** Map a GitHub /user (+ primary email) response onto our identity shape. */
export function identityFromGithubUser(user, email = null, emailVerified = null) {
  if (!user || user.id == null) throw new Error('GitHub user response missing id');
  return {
    provider: 'github',
    providerSub: String(user.id),
    email: email || user.email || null,
    name: user.name || user.login || null,
    emailVerified: emailVerified,
  };
}

/**
 * Exchange a callback code for a GitHub access token, then fetch the user's
 * identity. The two network calls take an injectable `fetchImpl` for tests.
 *
 * @returns {Promise<{ identity: object, tokens: object }>}
 */
export async function handleGithubCallback({
  code, state, expectedState,
  clientId, clientSecret, redirectUri, fetchImpl = fetch,
} = {}) {
  if (!state || !expectedState || state !== expectedState) {
    const err = new Error('GitHub OAuth state mismatch (possible CSRF)');
    err.code = 'OIDC_STATE';
    throw err;
  }
  if (!code) throw new Error('GitHub callback missing code');

  clientId = clientId || env('SCOPE_GITHUB_CLIENT_ID');
  clientSecret = clientSecret || env('SCOPE_GITHUB_CLIENT_SECRET');
  redirectUri = redirectUri || env('SCOPE_GITHUB_REDIRECT');

  // --- token exchange (UNVERIFIABLE without a real provider) ---
  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri,
    }).toString(),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`GitHub token exchange failed: ${tokenRes.status} ${text}`);
  }
  const tokens = await tokenRes.json();
  const accessToken = tokens.access_token;
  if (!accessToken) throw new Error('GitHub token response missing access_token');

  const ghHeaders = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'scope-hub',
  };

  // --- identity fetch ---
  const userRes = await fetchImpl(USER_URL, { headers: ghHeaders });
  if (!userRes.ok) throw new Error(`GitHub /user failed: ${userRes.status}`);
  const user = await userRes.json();

  // Email may be private on /user; pull the primary verified one from /user/emails.
  let email = user.email || null;
  let emailVerified = null;
  try {
    const emailsRes = await fetchImpl(EMAILS_URL, { headers: ghHeaders });
    if (emailsRes.ok) {
      const emails = await emailsRes.json();
      const primary = Array.isArray(emails) ? emails.find((e) => e.primary) || emails[0] : null;
      if (primary) { email = primary.email; emailVerified = primary.verified ?? null; }
    }
  } catch { /* /user/emails is best-effort; fall back to user.email */ }

  return { identity: identityFromGithubUser(user, email, emailVerified), tokens };
}
