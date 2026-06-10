/**
 * Per-user API keys (SCP-130) — non-interactive credentials for the CLI and
 * agents. Per ADR 0003 §1, a key carries only the HUMAN principal; the acting
 * model is supplied per request (X-Scope-Model), never baked into the key.
 *
 * Key shape: `sk_<id>.<secret>`. The id is a public lookup handle; only the
 * secret is sensitive. At rest we store sha-256(secret) (the DDL in schema.js,
 * api_keys.key_hash) — the plaintext is shown ONCE at creation and never
 * persisted. Verification is a single-row lookup by id then a constant-time
 * hash compare, with revoked_at enforced.
 *
 * sha-256 (not scrypt) is deliberate: an API-key secret is a full-entropy
 * 256-bit random value, not a low-entropy human password, so a slow KDF buys
 * nothing and would tax every request. (For the optional email+password
 * fallback in SCP-129, use scrypt instead — see note at bottom.)
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { ROLE_RANK } from './schema.js';

const PREFIX = 'sk_';

/**
 * Generate a new API key. Returns the plaintext (shown once) plus the id and
 * hash to persist. The plaintext is NEVER stored.
 * @returns {{ plaintext: string, id: string, hash: string }}
 */
export function generateKey() {
  const id = randomBytes(8).toString('hex');     // public lookup handle
  const secret = randomBytes(32).toString('hex'); // 256 bits of entropy
  const plaintext = `${PREFIX}${id}.${secret}`;
  return { plaintext, id, hash: hashKey(secret) };
}

/** sha-256 of the secret, hex. Accepts either the raw secret or a full key. */
export function hashKey(secretOrPlaintext) {
  const secret = extractSecret(secretOrPlaintext);
  return createHash('sha256').update(secret).digest('hex');
}

/** Pull { id, secret } out of a presented `sk_<id>.<secret>` (or accept a raw secret). */
export function parseKey(plaintext) {
  if (typeof plaintext !== 'string') throw new Error('api key must be a string');
  const body = plaintext.startsWith(PREFIX) ? plaintext.slice(PREFIX.length) : plaintext;
  const dot = body.indexOf('.');
  if (dot < 1) throw new Error('malformed api key');
  const id = body.slice(0, dot);
  const secret = body.slice(dot + 1);
  if (!id || !secret) throw new Error('malformed api key');
  return { id, secret };
}

function extractSecret(plaintext) {
  // If it looks like a full key, take the secret half; else treat as a raw secret.
  if (typeof plaintext === 'string' && (plaintext.startsWith(PREFIX) || plaintext.includes('.'))) {
    try { return parseKey(plaintext).secret; } catch { /* fall through */ }
  }
  return plaintext;
}

/**
 * Constant-time compare a presented secret against a stored hash. Pure — no DB —
 * so it unit-tests trivially.
 * @returns {boolean}
 */
export function verifyKey(presentedPlaintext, storedHash) {
  let presentedHash;
  try { presentedHash = hashKey(presentedPlaintext); } catch { return false; }
  const a = Buffer.from(presentedHash, 'hex');
  const b = Buffer.from(String(storedHash || ''), 'hex');
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* --------------------------- Postgres wrappers --------------------------- */

/**
 * Create + persist a named API key for an account. Returns the plaintext ONCE.
 * @param {import('pg').Pool} pool
 * @param {{ accountId: string, name: string, tenantId?: string|null, now?: number }} args
 * @returns {Promise<{ plaintext: string, id: string }>}
 */
export async function createApiKey(pool, { accountId, name, tenantId = null, now } = {}) {
  if (!accountId) throw new Error('createApiKey: accountId required');
  if (!name) throw new Error('createApiKey: name required');
  const { plaintext, id, hash } = generateKey();
  const ts = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  await pool.query(
    `INSERT INTO api_keys (id, account_id, name, key_hash, tenant_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, accountId, name, hash, tenantId, ts]
  );
  return { plaintext, id };
}

/**
 * Authenticate a presented API key. Returns the resolved principal context
 * (the account id + any project scope) or null if invalid/revoked.
 * @param {import('pg').Pool} pool
 * @param {string} presented - `sk_<id>.<secret>`
 * @returns {Promise<{ accountId: string, keyId: string, tenantId: string|null } | null>}
 */
export async function authenticateApiKey(pool, presented) {
  let id;
  try { ({ id } = parseKey(presented)); } catch { return null; }
  const row = (await pool.query('SELECT * FROM api_keys WHERE id=$1', [id])).rows[0];
  if (!row || row.revoked_at) return null;
  if (!verifyKey(presented, row.key_hash)) return null;
  // Debounced last_used bookkeeping (best-effort; don't fail auth on write error).
  pool.query('UPDATE api_keys SET last_used_at=$2 WHERE id=$1', [id, new Date().toISOString()])
    .catch(() => {});
  return { accountId: row.account_id, keyId: row.id, tenantId: row.tenant_id ?? null };
}

/**
 * Revoke a key by id (idempotent). When `accountId` is given the revoke is
 * scoped to that owner — required for the HTTP route so one account can't
 * revoke another account's keys by id (SCP-199). Returns true iff a row was
 * revoked (lets the caller 404 on a foreign/unknown id).
 */
export async function revokeApiKey(pool, id, { accountId = null, now } = {}) {
  const ts = new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
  const sql = accountId
    ? `UPDATE api_keys SET revoked_at=$2 WHERE id=$1 AND account_id=$3 AND revoked_at IS NULL`
    : `UPDATE api_keys SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL`;
  const params = accountId ? [id, ts, accountId] : [id, ts];
  const r = await pool.query(sql, params);
  return r.rowCount > 0;
}

/** List an account's keys (never returns hashes). */
export async function listApiKeys(pool, accountId) {
  const rows = (await pool.query(
    `SELECT id, name, tenant_id, created_at, last_used_at, revoked_at
       FROM api_keys WHERE account_id=$1 ORDER BY created_at`, [accountId]
  )).rows;
  return rows;
}

// Re-export so the CLI command layer (out of scope here) has the role ranks
// it needs to label project-scoped keys.
export { ROLE_RANK };

/*
 * NOTE for SCP-129 password fallback: passwords are low-entropy, so hash them
 * with crypto.scryptSync(password, salt, 64) and store salt+hash — do NOT reuse
 * hashKey() (sha-256) for passwords. API keys are full-entropy randoms, hence
 * the fast sha-256 here.
 */
