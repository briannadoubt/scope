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

import { pgConfigured, getPool } from '../pg/pool.js';
import { ensureSchema } from '../pg/schema.js';
import { ensureAuthSchema } from './schema.js';
import {
  mintAccessToken, verifyAccessToken,
  issueRefreshToken, storeRefreshToken, rotateRefreshToken, revokeRefreshToken,
} from './sessions.js';
import { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey } from './apikeys.js';
import { upsertAccount, createProject, listMemberships } from './membership.js';
import { githubConfigured, buildGithubAuthUrl, handleGithubCallback } from './github.js';
import { oidcConfigured, buildAuthUrl, discover, handleCallback } from './oidc.js';

const SESSION_COOKIE = 'scope_session';
const REFRESH_COOKIE = 'scope_refresh';
const STATE_COOKIE = 'scope_oauth_state';

/* ------------------------------- enable gate ------------------------------ */

function jwtSecretSet() {
  const s = process.env.SCOPE_JWT_SECRET;
  return typeof s === 'string' && s.length >= 16;
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
    try {
      if (githubConfigured()) {
        const { url, state } = buildGithubAuthUrl();
        appendCookie(res, cookie(STATE_COOKIE, `gh:${state}`, { maxAge: 600 }));
        return res.redirect(url);
      }
      if (oidcConfigured()) {
        const disc = await discover();
        const { url, state, codeVerifier } = buildAuthUrl({ authorizationEndpoint: disc.authorization_endpoint });
        appendCookie(res, cookie(STATE_COOKIE, `oidc:${state}:${codeVerifier}`, { maxAge: 600 }));
        return res.redirect(url);
      }
      return res.status(200).type('html').send(signinUnavailablePage());
    } catch (e) {
      return res.status(500).json({ error: e.message });
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
        ({ identity } = await handleGithubCallback({ code, state, expectedState: stash.slice(3) }));
      } else if (stash.startsWith('oidc:')) {
        const [, expectedState, codeVerifier] = stash.split(':');
        const disc = await discover();
        ({ identity } = await handleCallback({
          code, state, expectedState, codeVerifier, tokenEndpoint: disc.token_endpoint,
        }));
      } else {
        return res.status(400).json({ error: 'missing or expired oauth state' });
      }

      if (!identity.email) return res.status(400).json({ error: 'provider did not return an email' });
      const accountId = await upsertAccount(pool, identity);

      // First login with no project: give the user a personal project so the
      // session has a tenant to scope to. Project picker/UI is SCP-174.
      const memberships = await listMemberships(pool, accountId);
      if (memberships.length === 0) {
        await createProject(pool, { name: `${identity.name || identity.email}'s project`, ownerAccountId: accountId });
      }

      await issueSession(pool, res, accountId);
      return res.redirect(appPath);
    } catch (e) {
      const status = e.code === 'OIDC_STATE' ? 400 : 500;
      return res.status(status).json({ error: e.message });
    }
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
    await revokeApiKey(pool, req.params.id);
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
  return pool;
}

export const _internals = { parseCookies, claimsForAccount, SESSION_COOKIE, REFRESH_COOKIE, STATE_COOKIE };
