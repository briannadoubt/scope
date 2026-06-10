/**
 * Sessions (SCP-129) — short-lived HS256 access tokens + long-lived rotating
 * refresh tokens. Implemented with node:crypto only (no jsonwebtoken dep).
 *
 * Access token: a compact JWS (header.payload.signature), HS256, signed with
 * SCOPE_JWT_SECRET. Claims carry `sub` (the human account id — the principal,
 * ADR 0003 §2) plus optional project/role claims (`tenant_id`, `role`) so the
 * push-path authz (SCP-132) and tenancy checks read identity straight off the
 * verified token, never off a client header (ADR 0003 §4). TTL is short
 * (default 15 min) — long-lived auth lives in the rotating refresh token.
 *
 * Refresh token: opaque `<id>.<secret>`. Only sha-256(secret) is stored
 * (schema.js refresh_tokens). `rotateRefreshToken` consumes one and chains a
 * successor; presenting an already-rotated token is reuse — we revoke the whole
 * chain (theft response).
 */
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const DEFAULT_ACCESS_TTL = 15 * 60; // seconds
const DEFAULT_REFRESH_TTL_DAYS = 30;

/* --------------------------- base64url helpers --------------------------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}
function fromB64url(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function jwtSecret() {
  const s = process.env.SCOPE_JWT_SECRET;
  if (!isStrongSecret(s)) {
    throw new Error(
      'SCOPE_JWT_SECRET must be a high-entropy value (>=32 chars, not a repeated/degenerate string). ' +
      'Generate one with: openssl rand -base64 48'
    );
  }
  return s;
}

/**
 * A usable HS256 secret: >=32 chars and not a degenerate low-entropy string
 * (SCP-212). HMAC-SHA256 security rests entirely on the secret being
 * unguessable; a length-only gate let "aaaa…"/dictionary secrets through, which
 * are offline-brute-forceable from any captured JWT -> forge arbitrary sessions.
 * This is a coarse heuristic (true entropy can't be measured from a string),
 * but it blocks the obvious footguns; real deployments must use a random secret.
 */
export function isStrongSecret(s) {
  if (typeof s !== 'string' || s.length < 32) return false;
  if (new Set(s).size < 8) return false; // "aaaa…", "ababab…", etc.
  return true;
}

function sign(signingInput, secret) {
  return b64url(createHmac('sha256', secret).update(signingInput).digest());
}

// Issuer/audience binding (SCP-215): stamped on mint and enforced on verify so a
// token can't be replayed across a differently-purposed service that happens to
// share the secret. Fixed identifiers (overridable by env for multi-service).
const TOKEN_ISS = process.env.SCOPE_JWT_ISS || 'scope-hub';
const TOKEN_AUD = process.env.SCOPE_JWT_AUD || 'scope-hub-api';

/* ------------------------------ access tokens ----------------------------- */

/**
 * Mint a short-lived HS256 access token.
 * @param {object} claims - must include `sub`; may include tenant_id, role, etc.
 * @param {object} [opts]
 * @param {number} [opts.ttlSeconds] - default 15 min
 * @param {string} [opts.secret] - override the env secret (tests)
 * @param {number} [opts.now] - epoch seconds, for deterministic tests
 * @returns {string} compact JWS
 */
export function mintAccessToken(claims, { ttlSeconds = DEFAULT_ACCESS_TTL, secret, now } = {}) {
  if (!claims || typeof claims.sub !== 'string' || !claims.sub) {
    throw new Error('mintAccessToken: claims.sub (the human principal) is required');
  }
  const secretKey = secret || jwtSecret();
  const iat = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  const payload = { iss: TOKEN_ISS, aud: TOKEN_AUD, ...claims, iat, exp: iat + ttlSeconds };
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  return `${signingInput}.${sign(signingInput, secretKey)}`;
}

/**
 * Verify an access token's signature, algorithm, and expiry. Throws on any
 * failure (bad shape, wrong alg, bad signature, expired). Returns the claims.
 * @param {string} token
 * @param {object} [opts] - { secret, now } (tests)
 * @returns {object} the verified claims
 */
export function verifyAccessToken(token, { secret, now } = {}) {
  if (typeof token !== 'string') throw new Error('token must be a string');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, sig] = parts;

  let header;
  try { header = JSON.parse(fromB64url(h).toString('utf8')); }
  catch { throw new Error('malformed token header'); }
  // Pin the algorithm — never trust the header's alg to pick the verifier
  // (the classic "alg: none" / algorithm-confusion attack).
  if (header.alg !== 'HS256') throw new Error(`unsupported alg ${JSON.stringify(header.alg)}`);

  const secretKey = secret || jwtSecret();
  const expected = sign(`${h}.${p}`, secretKey);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('bad signature');

  let claims;
  try { claims = JSON.parse(fromB64url(p).toString('utf8')); }
  catch { throw new Error('malformed token payload'); }

  const t = Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && t >= claims.exp) throw new Error('token expired');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('token missing sub');
  // Enforce issuer/audience (SCP-215) — reject tokens minted for another service.
  if (claims.iss !== TOKEN_ISS) throw new Error('bad token issuer');
  if (claims.aud !== TOKEN_AUD) throw new Error('bad token audience');
  return claims;
}

/* ----------------------------- refresh tokens ----------------------------- */

function newId() { return 'rt_' + randomBytes(9).toString('hex'); }
function newSecret() { return randomBytes(32).toString('hex'); }
function hashSecret(secret) { return createHash('sha256').update(secret).digest('hex'); }

/**
 * Issue a fresh refresh token for an account. Returns the PLAINTEXT token
 * (`<id>.<secret>`, shown once) and the row to persist. Only the hash is stored.
 * @param {string} accountId
 * @param {object} [opts] - { ttlDays, now }
 * @returns {{ token: string, row: object }}
 */
export function issueRefreshToken(accountId, { ttlDays = DEFAULT_REFRESH_TTL_DAYS, now } = {}) {
  if (!accountId) throw new Error('issueRefreshToken: accountId required');
  const id = newId();
  const secret = newSecret();
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const row = {
    id,
    account_id: accountId,
    token_hash: hashSecret(secret),
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttlDays * 86400_000).toISOString(),
    rotated_to: null,
    revoked_at: null,
  };
  return { token: `${id}.${secret}`, row };
}

/** Split + hash a presented refresh token into { id, hash } for lookup. */
export function parseRefreshToken(token) {
  if (typeof token !== 'string') throw new Error('refresh token must be a string');
  const dot = token.indexOf('.');
  if (dot < 1) throw new Error('malformed refresh token');
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!id || !secret) throw new Error('malformed refresh token');
  return { id, hash: hashSecret(secret) };
}

/**
 * Validate a stored refresh-token row against a presented token's hash, given
 * the current time. Pure (no DB) so it unit-tests without Postgres; the
 * persistence wrapper below threads the rows through a pool.
 * @returns {{ ok: true } | { ok: false, reason: string, reuse?: boolean }}
 */
export function checkRefreshRow(row, presentedHash, { now } = {}) {
  if (!row) return { ok: false, reason: 'unknown refresh token' };
  const stored = Buffer.from(row.token_hash || '');
  const given = Buffer.from(presentedHash || '');
  if (stored.length !== given.length || !timingSafeEqual(stored, given)) {
    return { ok: false, reason: 'unknown refresh token' };
  }
  if (row.revoked_at) return { ok: false, reason: 'refresh token revoked' };
  // A rotated token presented again is reuse — treat as theft.
  if (row.rotated_to) return { ok: false, reason: 'refresh token reuse detected', reuse: true };
  const t = Number.isFinite(now) ? now : Date.now();
  if (Date.parse(row.expires_at) <= t) return { ok: false, reason: 'refresh token expired' };
  return { ok: true };
}

/**
 * Rotate a refresh token against Postgres: verify the presented token, mark the
 * old row rotated, insert a successor, and return the new plaintext token. On
 * reuse of an already-rotated token, revoke the whole account's chain.
 *
 * @param {import('pg').Pool} pool
 * @param {string} presented - the plaintext `<id>.<secret>`
 * @param {object} [opts] - { ttlDays, now }
 * @returns {Promise<{ token: string, accountId: string, row: object }>}
 */
export async function rotateRefreshToken(pool, presented, { ttlDays = DEFAULT_REFRESH_TTL_DAYS, now } = {}) {
  const { id, hash } = parseRefreshToken(presented);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = (await client.query('SELECT * FROM refresh_tokens WHERE id=$1 FOR UPDATE', [id])).rows[0];
    const check = checkRefreshRow(cur, hash, { now });
    if (!check.ok) {
      if (check.reuse && cur) {
        // Theft response: nuke every live refresh token for this account.
        await client.query(
          `UPDATE refresh_tokens SET revoked_at=$2 WHERE account_id=$1 AND revoked_at IS NULL`,
          [cur.account_id, new Date(Number.isFinite(now) ? now : Date.now()).toISOString()]
        );
      }
      await client.query('COMMIT');
      const err = new Error(check.reason);
      err.code = check.reuse ? 'REFRESH_REUSE' : 'REFRESH_INVALID';
      throw err;
    }
    const { token, row } = issueRefreshToken(cur.account_id, { ttlDays, now });
    await client.query(
      `INSERT INTO refresh_tokens (id, account_id, token_hash, created_at, expires_at, rotated_to, revoked_at)
       VALUES ($1,$2,$3,$4,$5,NULL,NULL)`,
      [row.id, row.account_id, row.token_hash, row.created_at, row.expires_at]
    );
    await client.query('UPDATE refresh_tokens SET rotated_to=$2 WHERE id=$1', [id, row.id]);
    await client.query('COMMIT');
    return { token, accountId: cur.account_id, row };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Persist a freshly-issued refresh-token row (e.g. right after login). */
export async function storeRefreshToken(pool, row) {
  await pool.query(
    `INSERT INTO refresh_tokens (id, account_id, token_hash, created_at, expires_at, rotated_to, revoked_at)
     VALUES ($1,$2,$3,$4,$5,NULL,NULL)`,
    [row.id, row.account_id, row.token_hash, row.created_at, row.expires_at]
  );
}

/** Revoke a single refresh token (logout). Idempotent. */
export async function revokeRefreshToken(pool, presented, { now } = {}) {
  const { id } = parseRefreshToken(presented);
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL`,
    [id, new Date(Number.isFinite(now) ? now : Date.now()).toISOString()]
  );
}

export const _internals = { hashSecret };
