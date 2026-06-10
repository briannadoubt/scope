/**
 * Cloud auth integration (SCP-170/171/172) — the glue that wires the hosted
 * identity modules (oidc/github/sessions/apikeys/membership/authz) into the
 * Express server's CLOUD path. This is the only auth_hosted file the server
 * imports.
 *
 * SAFE-ROLLOUT GATE (hostedAuthEnabled): the new auth path turns on ONLY when
 * the hub is in cloud mode AND Postgres is configured AND a JWT secret is set.
 * Until then the server keeps its interim single shared-token middleware, so
 * deploying this code does NOT break a hub that hasn't provisioned PG/OAuth yet.
 * Nothing here runs on the local/LAN path — see ADR 0003 §5.
 *
 * What "enabled" replaces (ADR 0003):
 *   - shared bearer token + loopback bypass  ->  per-request identity:
 *       * Bearer sk_… / X-Api-Key            ->  per-user API key (apikeys.js)
 *       * Bearer <jwt> / scope_session cookie->  short-lived session (sessions.js)
 *   - the principal (req.principal.accountId) is the human account; the acting
 *     model still rides per-request in X-Scope-Model (SCP-128, unchanged).
 */
import express from 'express';
import { serverError } from '../http-errors.js';

import { pgConfigured, getPool } from '../pg/pool.js';
import { ensureSchema } from '../pg/schema.js';
import { ensureRls } from '../pg/rls.js';
import { ensureQuotaSchema } from '../quota/quota.js';
import { ensureAuthSchema } from './schema.js';
import {
  mintAccessToken, verifyAccessToken,
  issueRefreshToken, storeRefreshToken, rotateRefreshToken, revokeRefreshToken,
  isStrongSecret,
} from './sessions.js';
import { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey } from './apikeys.js';
import { upsertAccount, listMemberships } from './membership.js';
import { createProjectBoard } from './tenant-board.js';
import { githubConfigured, buildGithubAuthUrl, handleGithubCallback } from './github.js';
import { oidcConfigured, buildAuthUrl, discover, handleCallback } from './oidc.js';
import { lookupInvite, acceptInvite } from './invites.js';

const SESSION_COOKIE = 'scope_session';
const REFRESH_COOKIE = 'scope_refresh';
const STATE_COOKIE = 'scope_oauth_state';
const INVITE_COOKIE = 'scope_invite'; // carries an invite code across the OAuth round-trip (SCP-228)

/** A safe invite-code shape (base64url, what randomBytes(16).toString('base64url') emits). */
function safeInviteCode(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
}

/* ------------------------------- enable gate ------------------------------ */

function jwtSecretSet() {
  return isStrongSecret(process.env.SCOPE_JWT_SECRET); // >=32 chars, non-degenerate (SCP-212)
}

/**
 * True when the hosted auth path should be active. Requires cloud + Postgres +
 * a JWT secret. A login provider (GitHub/OIDC) is NOT required for the gate —
 * API-key auth works without one — but interactive login routes 501 until a
 * provider is configured.
 */
export function hostedAuthEnabled(cloud) {
  return !!cloud && pgConfigured() && jwtSecretSet();
}

/** True when an interactive login provider is configured. */
export function loginProviderConfigured() {
  return githubConfigured() || oidcConfigured();
}

/* --------------------------------- CSRF ----------------------------------- */

/**
 * CSRF guard for cookie-authenticated state changes (SCP-204). The session
 * lives in a cookie, so a cross-site page could drive POST/PATCH/DELETE with the
 * victim's ambient cookie. Defenses:
 *   - safe methods (GET/HEAD/OPTIONS) pass.
 *   - requests bearing Authorization/X-Api-Key pass — token creds aren't ambient,
 *     so they're not CSRF-able (the CLI/agent path).
 *   - otherwise require a same-site signal: Sec-Fetch-Site in {same-origin,
 *     same-site,none} (none = user-initiated top-level), or an Origin whose host
 *     matches the request host. Cross-site cookie-driven mutations are 403'd.
 * Mounted before the login routes so /auth/refresh and /auth/logout are covered.
 */
export function csrfGuard() {
  return (req, res, next) => {
    const m = req.method;
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
    if (req.headers.authorization || req.headers['x-api-key']) return next();
    const sfs = req.headers['sec-fetch-site'];
    if (sfs) {
      if (sfs === 'same-origin' || sfs === 'same-site' || sfs === 'none') return next();
      return res.status(403).json({ error: 'cross-site request blocked', code: 'CSRF' });
    }
    const origin = req.headers.origin;
    if (!origin) return next(); // no Origin (e.g. same-origin client that omits it) — allow
    try { if (new URL(origin).host === req.headers.host) return next(); } catch { /* malformed */ }
    return res.status(403).json({ error: 'cross-site request blocked', code: 'CSRF' });
  };
}

/* ------------------------------ cookie helpers ---------------------------- */

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Cookies are Secure (the cloud edge terminates TLS) and SameSite=Lax so the
// state cookie survives the top-level redirect back from the provider.
function cookie(name, value, { maxAge, clear = false } = {}) {
  const attrs = [`${name}=${clear ? '' : encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'];
  attrs.push(`Max-Age=${clear ? 0 : maxAge}`);
  return attrs.join('; ');
}

function appendCookie(res, str) {
  const prev = res.getHeader('Set-Cookie');
  const next = prev ? (Array.isArray(prev) ? [...prev, str] : [prev, str]) : str;
  res.setHeader('Set-Cookie', next);
}

/* ------------------------------ credential mw ----------------------------- */

function bearer(req) {
  const a = req.headers.authorization;
  if (a && a.startsWith('Bearer ')) return a.slice(7).trim();
  if (typeof req.headers['x-api-key'] === 'string') return req.headers['x-api-key'].trim();
  return null;
}

/**
 * Express middleware enforcing per-user identity in cloud mode. Sets
 * `req.principal = { accountId, kind, tenantId, role }` on success, 401 on
 * failure. No loopback bypass, no host allowlist — the edge proxy routes by
 * host and there is no trusted local peer in a container.
 */
export function hostedAuthMiddleware({ pool }) {
  return async (req, res, next) => {
    try {
      const tok = bearer(req);
      // API keys are non-interactive creds: prefix sk_ (apikeys.js).
      if (tok && tok.startsWith('sk_')) {
        const ctx = await authenticateApiKey(pool, tok);
        if (!ctx) return res.status(401).json({ error: 'unauthorized' });
        req.principal = { accountId: ctx.accountId, kind: 'apikey', tenantId: ctx.tenantId, role: null };
        return next();
      }
      // Otherwise a session JWT — Authorization: Bearer <jwt> or the cookie.
      const cookies = parseCookies(req.headers.cookie);
      const jwt = tok || cookies[SESSION_COOKIE];
      if (jwt) {
        const claims = verifyAccessToken(jwt); // throws on bad/expired
        req.principal = {
          accountId: claims.sub, kind: 'session',
          tenantId: claims.tenant_id ?? null, role: claims.role ?? null,
        };
        return next();
      }
      return res.status(401).json({ error: 'unauthorized' });
    } catch {
      return res.status(401).json({ error: 'unauthorized' });
    }
  };
}

/** True iff the request carries a valid (unexpired, signed) session cookie.
 * Used to send already-signed-in visitors straight to the app instead of the
 * marketing landing (SCP-231). Safe in interim mode (no JWT secret => false). */
export function hasValidSession(req) {
  try {
    const jwt = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!jwt) return false;
    verifyAccessToken(jwt);
    return true;
  } catch { return false; }
}

/* ------------------------------ route helpers ----------------------------- */

/** Build the JWT claims for an account from its first membership (if any). */
async function claimsForAccount(pool, accountId) {
  const memberships = await listMemberships(pool, accountId);
  const first = memberships[0];
  return {
    sub: accountId,
    tenant_id: first ? first.tenant_id : null,
    role: first ? first.role : null,
  };
}

/** Issue a session (access cookie + rotating refresh cookie) for an account. */
async function issueSession(pool, res, accountId) {
  const claims = await claimsForAccount(pool, accountId);
  const access = mintAccessToken(claims);
  const { token: refresh, row } = issueRefreshToken(accountId);
  await storeRefreshToken(pool, row);
  appendCookie(res, cookie(SESSION_COOKIE, access, { maxAge: 15 * 60 }));
  appendCookie(res, cookie(REFRESH_COOKIE, refresh, { maxAge: 30 * 86400 }));
}

/* ------------------------------ public routes ----------------------------- */

/**
 * A small, styled "sign-in isn't enabled here yet" page. Served when a visitor
 * clicks "Sign in" on a hub that hasn't finished provisioning (no Postgres / no
 * JWT secret / no OAuth app) — far friendlier than a bare 401/501, and it hits
 * both the un-provisioned production hub and the local cloud preview.
 */
function signinUnavailablePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in not enabled — Scope</title>
<style>
  :root { --bg:#0d1117; --text:#e6edf3; --muted:#8b949e; --accent:#2f81f7; --border:#30363d; }
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}
  .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;
    background:radial-gradient(900px 420px at 50% -120px,rgba(47,129,247,.18),transparent 70%);}
  .card{max-width:460px;text-align:center;border:1px solid var(--border);border-radius:12px;
    background:#161b22;padding:36px 30px;}
  .mark{color:var(--accent);font-size:26px;}
  h1{font-size:21px;margin:14px 0 10px;}
  p{color:var(--muted);margin:0 0 20px;}
  a.btn{display:inline-block;padding:10px 18px;border-radius:8px;background:var(--accent);
    color:#fff;text-decoration:none;font-weight:600;}
  a.alt{color:var(--muted);text-decoration:none;display:inline-block;margin-top:14px;font-size:14px;}
</style></head>
<body><div class="wrap"><div class="card">
  <div class="mark">◆</div>
  <h1>Sign-in isn't enabled on this hub yet</h1>
  <p>This Scope hub is running without an identity provider configured.
     GitHub sign-in turns on once the hub has Postgres, a session secret, and a
     GitHub OAuth app set up.</p>
  <a class="btn" href="/">Back to home</a>
  <div><a class="alt" href="/docs/self-hosting">Read the self-hosting docs →</a></div>
</div></div></body></html>`;
}

/** The public invite landing (SCP-228). Project name is escaped (user-controlled). */
function invitePage({ projectName, role, loginHref, invalid, expired } = {}) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const body = invalid
    ? `<div class="mark">◆</div>
       <h1>${expired ? 'This invite has expired' : 'This invite link isn’t valid'}</h1>
       <p>${expired ? 'Ask the project owner to send a fresh invite.' : 'It may have been used already or revoked.'}</p>
       <a class="btn" href="/">Go to Scope</a>`
    : `<div class="mark">◆</div>
       <h1>You’re invited to ${esc(projectName)}</h1>
       <p>Join as <strong>${esc(role)}</strong>. Sign in with GitHub to accept.</p>
       <a class="btn" href="${esc(loginHref)}">Sign in with GitHub to join</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${invalid ? 'Invite' : 'Join ' + esc(projectName)} — Scope</title>
<style>
  :root { --bg:#0d1117; --text:#e6edf3; --muted:#8b949e; --accent:#2f81f7; --border:#30363d; }
  html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}
  .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;
    background:radial-gradient(900px 420px at 50% -120px,rgba(47,129,247,.18),transparent 70%);}
  .card{max-width:460px;text-align:center;border:1px solid var(--border);border-radius:12px;
    background:#161b22;padding:36px 30px;}
  .mark{color:var(--accent);font-size:26px;}
  h1{font-size:21px;margin:14px 0 10px;}
  p{color:var(--muted);margin:0 0 20px;}
  strong{color:var(--text);}
  a.btn{display:inline-block;padding:10px 18px;border-radius:8px;background:var(--accent);
    color:#fff;text-decoration:none;font-weight:600;}
</style></head>
<body><div class="wrap"><div class="card">${body}</div></div></body></html>`;
}

/**
 * The unauthenticated auth routes (login/callback/refresh/logout). Mounted
 * BEFORE the credential gate, in ALL cloud modes — when hosted auth isn't fully
 * enabled (no pool / no provider) /auth/login serves a friendly "not enabled"
 * page instead of falling through to the gate's 401. Returns an express.Router.
 */
export function publicAuthRouter({ pool, appPath = '/app' }) {
  const r = express.Router();

  // Kick off interactive login. GitHub first (it's the configured default);
  // generic OIDC as a fallback for Google/Apple etc. If the hub can't actually
  // complete a login (no DB to upsert accounts, or no provider), show the
  // friendly unavailable page rather than starting a flow that would dead-end.
  r.get('/auth/login', async (req, res) => {
    if (!pool || !loginProviderConfigured()) {
      return res.status(200).type('html').send(signinUnavailablePage());
    }
    // Carry an invite code through the OAuth round-trip (SCP-228) so a brand-new
    // user who clicked an invite link joins the board right after sign-in.
    const invite = safeInviteCode(req.query.invite);
    if (invite) appendCookie(res, cookie(INVITE_COOKIE, invite, { maxAge: 600 }));
    try {
      if (githubConfigured()) {
        // SCP-208: stash the PKCE verifier alongside state -> gh:<state>:<verifier>.
        const { url, state, codeVerifier } = buildGithubAuthUrl();
        appendCookie(res, cookie(STATE_COOKIE, `gh:${state}:${codeVerifier}`, { maxAge: 600 }));
        return res.redirect(url);
      }
      if (oidcConfigured()) {
        const disc = await discover();
        // SCP-207/208: stash verifier AND nonce -> oidc:<state>:<verifier>:<nonce>.
        const { url, state, codeVerifier, nonce } = buildAuthUrl({ authorizationEndpoint: disc.authorization_endpoint });
        appendCookie(res, cookie(STATE_COOKIE, `oidc:${state}:${codeVerifier}:${nonce}`, { maxAge: 600 }));
        return res.redirect(url);
      }
      return res.status(200).type('html').send(signinUnavailablePage());
    } catch (e) {
      return serverError(res, e);
    }
  });

  // Provider redirect target. Verify state, exchange the code, upsert the
  // account, ensure a project exists, issue a session, and land in the app.
  r.get('/auth/callback', async (req, res) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const stash = cookies[STATE_COOKIE] || '';
      appendCookie(res, cookie(STATE_COOKIE, '', { clear: true }));
      const { code, state } = req.query;

      let identity;
      if (stash.startsWith('gh:')) {
        // SCP-208: gh:<state>:<verifier> — feed the PKCE verifier to the exchange.
        const [, expectedState, codeVerifier] = stash.split(':');
        ({ identity } = await handleGithubCallback({ code, state, expectedState, codeVerifier }));
      } else if (stash.startsWith('oidc:')) {
        // SCP-207/208: oidc:<state>:<verifier>:<nonce>.
        const [, expectedState, codeVerifier, nonce] = stash.split(':');
        const disc = await discover();
        ({ identity } = await handleCallback({
          code, state, expectedState, codeVerifier, nonce,
          tokenEndpoint: disc.token_endpoint, jwksUri: disc.jwks_uri,
        }));
      } else {
        return res.status(400).json({ error: 'missing or expired oauth state' });
      }

      if (!identity.email) return res.status(400).json({ error: 'provider did not return an email' });
      // Require a VERIFIED email (SCP-203): upsertAccount links by lower(email)
      // when there's no (provider,provider_sub) match, so accepting an unverified
      // email lets an attacker take over a victim's account by presenting their
      // address. `null`/`false` => unverified.
      if (identity.emailVerified !== true) {
        return res.status(403).json({ error: 'your provider email is not verified; verify it and retry' });
      }
      const accountId = await upsertAccount(pool, identity);

      // First login with no project: provision a real, served project BOARD
      // (project row + owner membership + seeded workspace.init), not an
      // orphan projects row — the user lands on a working board (SCP-192).
      const memberships = await listMemberships(pool, accountId);
      if (memberships.length === 0) {
        await createProjectBoard(pool, {
          accountId,
          name: `${identity.name || identity.email}'s project`,
        });
      }

      await issueSession(pool, res, accountId);

      // If they arrived via an invite link, redeem it now (SCP-228) so they land
      // directly on the shared board. Best-effort: a stale/used invite just drops
      // them on their own board instead of erroring the whole sign-in.
      const invite = safeInviteCode(cookies[INVITE_COOKIE]);
      if (invite) {
        appendCookie(res, cookie(INVITE_COOKIE, '', { clear: true }));
        try { await acceptInvite(pool, invite, accountId); } catch { /* invalid/expired — ignore */ }
      }

      return res.redirect(appPath);
    } catch (e) {
      const status = e.code === 'OIDC_STATE' ? 400 : 500;
      return res.status(status).json({ error: e.message });
    }
  });

  // PUBLIC invite landing (SCP-228): the link people actually share. Works for a
  // logged-OUT visitor (the old /app?invite= 401'd). If already signed in, redeem
  // immediately and go to the board; otherwise show a "sign in to join" page that
  // carries the code through GitHub sign-in.
  r.get('/invite/:code', async (req, res) => {
    const code = safeInviteCode(req.params.code);
    if (!pool || !code) return res.status(404).type('html').send(invitePage({ invalid: true }));
    let info;
    try { info = await lookupInvite(pool, code); } catch { return serverError(res, undefined); }

    // Already signed in? Redeem now and bounce to the app.
    const cookies = parseCookies(req.headers.cookie);
    const jwt = cookies[SESSION_COOKIE];
    if (jwt) {
      try {
        const claims = verifyAccessToken(jwt);
        await acceptInvite(pool, code, claims.sub);
        return res.redirect(appPath);
      } catch { /* bad/expired session or invite — fall through to the page */ }
    }
    if (!info.valid) {
      return res.status(410).type('html').send(invitePage({ invalid: true, expired: info.reason === 'INVITE_EXPIRED', projectName: info.projectName }));
    }
    return res.status(200).type('html').send(invitePage({
      projectName: info.projectName, role: info.role, loginHref: `/auth/login?invite=${encodeURIComponent(code)}`,
    }));
  });

  // Exchange a refresh cookie for a fresh access (+ rotated refresh) cookie.
  r.post('/auth/refresh', async (req, res) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const presented = cookies[REFRESH_COOKIE];
      if (!presented) return res.status(401).json({ error: 'no refresh token' });
      const { token: newRefresh, accountId } = await rotateRefreshToken(pool, presented);
      const claims = await claimsForAccount(pool, accountId);
      appendCookie(res, cookie(SESSION_COOKIE, mintAccessToken(claims), { maxAge: 15 * 60 }));
      appendCookie(res, cookie(REFRESH_COOKIE, newRefresh, { maxAge: 30 * 86400 }));
      return res.json({ ok: true });
    } catch (e) {
      // Reuse/invalid: clear cookies so the client re-logs in.
      appendCookie(res, cookie(SESSION_COOKIE, '', { clear: true }));
      appendCookie(res, cookie(REFRESH_COOKIE, '', { clear: true }));
      return res.status(401).json({ error: e.message });
    }
  });

  // Log out: revoke the refresh token and clear cookies.
  r.post('/auth/logout', async (req, res) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[REFRESH_COOKIE]) await revokeRefreshToken(pool, cookies[REFRESH_COOKIE]).catch(() => {});
    } finally {
      appendCookie(res, cookie(SESSION_COOKIE, '', { clear: true }));
      appendCookie(res, cookie(REFRESH_COOKIE, '', { clear: true }));
      res.json({ ok: true });
    }
  });

  return r;
}

/* --------------------------- authenticated routes ------------------------- */

/**
 * API-key management — mounted AFTER the credential gate (needs req.principal).
 * Lets a signed-in user mint/list/revoke their own non-interactive keys
 * (replaces the shared --token for `scope sync`). Returns an express.Router.
 */
export function apiKeyRouter({ pool }) {
  const r = express.Router();

  r.post('/auth/keys', async (req, res) => {
    try {
      const name = (req.body && req.body.name) || '';
      if (!name) return res.status(400).json({ error: 'name required' });
      const { plaintext, id } = await createApiKey(pool, {
        accountId: req.principal.accountId, name, tenantId: req.principal.tenantId ?? null,
      });
      // The plaintext is shown exactly once.
      return res.status(201).json({ id, name, key: plaintext });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  });

  r.get('/auth/keys', async (req, res) => {
    res.json(await listApiKeys(pool, req.principal.accountId));
  });

  r.delete('/auth/keys/:id', async (req, res) => {
    // Scope to the caller's account so one account can't revoke another's keys
    // by id (SCP-199). 404 (not 200) when the id isn't the caller's.
    const ok = await revokeApiKey(pool, req.params.id, { accountId: req.principal.accountId });
    if (!ok) return res.status(404).json({ error: 'no such key' });
    res.json({ ok: true });
  });

  return r;
}

/* ------------------------------- boot helper ------------------------------ */

/**
 * Ensure the hosted-auth tables exist. Called once on cloud boot when enabled.
 * Idempotent (CREATE … IF NOT EXISTS).
 */
export async function ensureHostedAuthReady() {
  const pool = getPool();
  await ensureAuthSchema(pool);   // accounts/projects/memberships/api_keys/refresh_tokens
  await ensureSchema(pool);       // tenant event log + replayed cache (per-project boards)
  await ensureRls(pool);          // row-level security on the tenant tables (SCP-189);
                                  // binds when SCOPE_PG_APP_ROLE names a non-superuser role
  await ensureQuotaSchema(pool);  // per-tenant usage counters + plan limits (SCP-165)
  return pool;
}

export const _internals = { parseCookies, claimsForAccount, SESSION_COOKIE, REFRESH_COOKIE, STATE_COOKIE };
