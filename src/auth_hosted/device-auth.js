/**
 * Browser-approved device auth for CLI/agent login.
 *
 * The CLI starts with a high-entropy device code and a short human code. The
 * browser approves the human code under an existing session, and the polling
 * CLI receives one API key exactly once. The durable API key remains hashed in
 * api_keys; the plaintext is held only on this short-lived grant until consumed.
 */
import { createHash, randomBytes } from 'node:crypto';

import { createApiKey } from './apikeys.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 2000;
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function nowIso(now) {
  return new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
}

function hashValue(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function randomId() {
  return randomBytes(12).toString('hex');
}

function randomUserCode() {
  let raw = '';
  for (let i = 0; i < 8; i += 1) {
    raw += USER_CODE_ALPHABET[randomBytes(1)[0] % USER_CODE_ALPHABET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function isExpired(row, now) {
  return Date.parse(row.expires_at) <= now;
}

async function withTransaction(pool, fn) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* best effort */ }
    throw e;
  } finally {
    if (client !== pool && typeof client.release === 'function') client.release();
  }
}

export function normalizeUserCode(value) {
  const compact = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!/^[A-Z2-9]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function hashDeviceGrantCode(value) {
  return hashValue(value);
}

export async function issueDeviceGrant(pool, {
  clientName = 'Scope CLI',
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  if (!pool) throw new Error('issueDeviceGrant: pool required');
  const createdAt = nowIso(now);
  const expiresAt = nowIso(now + ttlMs);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const id = randomId();
    const deviceCode = `sdc_${randomBytes(32).toString('base64url')}`;
    const userCode = randomUserCode();
    try {
      await pool.query(
        `INSERT INTO device_auth_grants
           (id, device_code_hash, user_code_hash, client_name, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, hashValue(deviceCode), hashValue(userCode), String(clientName || 'Scope CLI'), createdAt, expiresAt]
      );
      return {
        id,
        deviceCode,
        userCode,
        expiresAt,
        expiresIn: Math.ceil(ttlMs / 1000),
        intervalMs,
        now,
      };
    } catch (e) {
      if (e?.code !== '23505' || attempt === 7) throw e;
    }
  }
  throw new Error('could not issue device grant');
}

export async function approveDeviceGrant(pool, { userCode, accountId, now = Date.now() } = {}) {
  if (!pool) throw new Error('approveDeviceGrant: pool required');
  if (!accountId) throw new Error('approveDeviceGrant: accountId required');
  const normalized = normalizeUserCode(userCode);
  if (!normalized) return { status: 'invalid' };
  return withTransaction(pool, async (client) => {
    const row = (await client.query(
      'SELECT * FROM device_auth_grants WHERE user_code_hash=$1 FOR UPDATE',
      [hashValue(normalized)]
    )).rows[0];
    if (!row) return { status: 'invalid' };
    if (row.consumed_at) return { status: 'consumed' };
    if (isExpired(row, now)) return { status: 'expired' };
    if (row.approved_at) return { status: 'approved', accountId: row.account_id, keyId: row.api_key_id };

    const { plaintext, id: keyId } = await createApiKey(client, {
      accountId,
      name: `device:${row.client_name || 'Scope CLI'}`,
      tenantId: null,
      now,
    });
    const approvedAt = nowIso(now);
    await client.query(
      `UPDATE device_auth_grants
          SET account_id=$2, api_key_id=$3, api_key_plaintext=$4, approved_at=$5
        WHERE id=$1`,
      [row.id, accountId, keyId, plaintext, approvedAt]
    );
    return { status: 'approved', accountId, keyId };
  });
}

export async function pollDeviceGrant(pool, {
  deviceCode,
  now = Date.now(),
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  if (!pool) throw new Error('pollDeviceGrant: pool required');
  if (!deviceCode) return { status: 'invalid' };
  return withTransaction(pool, async (client) => {
    const row = (await client.query(
      'SELECT * FROM device_auth_grants WHERE device_code_hash=$1 FOR UPDATE',
      [hashValue(deviceCode)]
    )).rows[0];
    if (!row) return { status: 'invalid' };
    if (row.consumed_at) return { status: 'consumed' };
    if (isExpired(row, now)) return { status: 'expired' };
    if (!row.approved_at) return { status: 'pending', intervalMs };
    if (!row.api_key_plaintext) return { status: 'consumed' };

    const key = row.api_key_plaintext;
    const consumedAt = nowIso(now);
    await client.query(
      `UPDATE device_auth_grants
          SET consumed_at=$2, api_key_plaintext=NULL
        WHERE id=$1`,
      [row.id, consumedAt]
    );
    return {
      status: 'approved',
      key,
      keyId: row.api_key_id,
      accountId: row.account_id,
    };
  });
}

export const DEVICE_AUTH_DEFAULTS = {
  ttlMs: DEFAULT_TTL_MS,
  intervalMs: DEFAULT_INTERVAL_MS,
};
