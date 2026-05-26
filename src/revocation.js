/**
 * Certificate revocation list (CRL) for paired devices.
 *
 * When `scope devices revoke <name>` runs, the device record is removed from
 * devices.json AND the cert's serial is appended to revoked.json. The auth
 * middleware consults an in-memory Set of revoked serials on every request —
 * even though the cert chains to the local CA and is technically valid until
 * its notAfter, a revoked serial gets 401.
 *
 * The in-memory cache is loaded on hub startup and re-loaded on SIGUSR1 so an
 * out-of-band `scope devices revoke` from another process can take effect
 * without restarting the hub.
 *
 * Layout (HUB_DIR/revoked.json):
 *   { "version": 1, "revoked": [ { "serial_hex": "00abcd...", "name": "...",
 *                                  "revoked_at": "2026-05-26T..." } ] }
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { HUB_DIR } from './ca.js';

export const REVOKED_PATH = join(HUB_DIR, 'revoked.json');

// Module-level cache. Loaded at startup, refreshed via reloadCrl().
let crlSet = null;

function emptyCrl() { return { version: 1, revoked: [] }; }

export function loadCrl() {
  if (!existsSync(REVOKED_PATH)) return emptyCrl();
  try {
    const raw = JSON.parse(readFileSync(REVOKED_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyCrl();
    if (!Array.isArray(raw.revoked)) raw.revoked = [];
    return raw;
  } catch {
    return emptyCrl();
  }
}

function writeAtomic(crl) {
  if (!existsSync(HUB_DIR)) mkdirSync(HUB_DIR, { recursive: true });
  const tmp = REVOKED_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(crl, null, 2));
  renameSync(tmp, REVOKED_PATH);
}

/** Build (or rebuild) the in-memory Set from disk. Returns the new Set. */
export function reloadCrl() {
  const crl = loadCrl();
  crlSet = new Set(crl.revoked.map((r) => r.serial_hex.toLowerCase()));
  return crlSet;
}

/** Returns true if `serialHex` is in the revoked set. Loads lazily on first call. */
export function isRevoked(serialHex) {
  if (!serialHex) return false;
  if (crlSet === null) reloadCrl();
  return crlSet.has(String(serialHex).toLowerCase());
}

/** Add a revocation entry. Persists to disk and updates the cache. Idempotent. */
export function revokeSerial({ serialHex, name }) {
  const crl = loadCrl();
  const s = String(serialHex).toLowerCase();
  if (!crl.revoked.some((r) => r.serial_hex === s)) {
    crl.revoked.push({
      serial_hex: s,
      name: name || null,
      revoked_at: new Date().toISOString(),
    });
    writeAtomic(crl);
  }
  reloadCrl();
  return s;
}

/** Remove a revocation entry (undo). Returns true if one was removed. */
export function unrevokeSerial(serialHex) {
  const crl = loadCrl();
  const s = String(serialHex).toLowerCase();
  const before = crl.revoked.length;
  crl.revoked = crl.revoked.filter((r) => r.serial_hex !== s);
  if (crl.revoked.length === before) return false;
  writeAtomic(crl);
  reloadCrl();
  return true;
}

export function listRevoked() {
  return loadCrl().revoked;
}

/**
 * Install a SIGUSR1 handler that reloads the CRL from disk. Lets a separate
 * `scope devices revoke` invocation poke the running hub to pick up the new
 * entry without a restart.
 */
export function installCrlReloadSignal() {
  process.on('SIGUSR1', () => {
    try { reloadCrl(); } catch {}
  });
}

// Exposed for tests.
export function _resetCrlCache() { crlSet = null; }
