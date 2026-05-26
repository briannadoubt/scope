/**
 * Device registry — every paired native client is recorded here.
 *
 * On-disk shape (HUB_DIR/devices.json):
 *   {
 *     "version": 1,
 *     "devices": [
 *       {
 *         "name": "bri-iphone",
 *         "serial_hex": "00abcdef...",      // lowercase, matches cert serial
 *         "fingerprint": "AA:BB:...",       // sha256 of the cert
 *         "paired_at": "2026-05-26T...",
 *         "last_seen": "2026-05-26T...",
 *         "not_after": "2026-08-24T..."
 *       }
 *     ]
 *   }
 *
 * Atomic write: write to a tmp file then rename. Last-seen is debounced
 * (LAST_SEEN_DEBOUNCE_MS) so a chatty mTLS client doesn't thrash the disk —
 * see updateLastSeen.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { HUB_DIR } from './ca.js';

export const DEVICES_PATH = join(HUB_DIR, 'devices.json');

const LAST_SEEN_DEBOUNCE_MS = 60_000;
const lastSeenCache = new Map(); // serial -> ms timestamp of last disk write

function ensureDir() {
  if (!existsSync(HUB_DIR)) mkdirSync(HUB_DIR, { recursive: true });
}

function emptyRegistry() {
  return { version: 1, devices: [] };
}

export function loadDevices() {
  if (!existsSync(DEVICES_PATH)) return emptyRegistry();
  try {
    const raw = JSON.parse(readFileSync(DEVICES_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyRegistry();
    if (!Array.isArray(raw.devices)) raw.devices = [];
    return raw;
  } catch {
    return emptyRegistry();
  }
}

function writeAtomic(reg) {
  ensureDir();
  const tmp = DEVICES_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, DEVICES_PATH);
}

function fingerprintFromCertPem(certPem) {
  const cert = new X509Certificate(certPem);
  const hex = createHash('sha256').update(cert.raw).digest('hex').toUpperCase();
  return hex.match(/.{2}/g).join(':');
}

/**
 * Add (or replace) a device by name. Returns the saved record.
 *
 * Replacement is by *name*: re-pairing a device with the same name supersedes
 * the prior cert (useful when the SwiftUI app reinstalls and needs a new
 * keypair). Other paired devices are untouched.
 */
export function addDevice({ name, certPem, serialHex, notAfter }) {
  if (!name || typeof name !== 'string') throw new Error('device name required');
  const reg = loadDevices();
  const fingerprint = fingerprintFromCertPem(certPem);
  const now = new Date().toISOString();
  const next = reg.devices.filter((d) => d.name !== name);
  const record = {
    name,
    serial_hex: serialHex.toLowerCase(),
    fingerprint,
    paired_at: now,
    last_seen: now,
    not_after: notAfter instanceof Date ? notAfter.toISOString() : notAfter,
  };
  next.push(record);
  writeAtomic({ ...reg, devices: next });
  return record;
}

export function listDevices() {
  return loadDevices().devices;
}

export function findDeviceBySerial(serialHex) {
  if (!serialHex) return null;
  const s = serialHex.toLowerCase();
  return loadDevices().devices.find((d) => d.serial_hex === s) ?? null;
}

export function findDeviceByName(name) {
  if (!name) return null;
  return loadDevices().devices.find((d) => d.name === name) ?? null;
}

export function removeDevice(name) {
  const reg = loadDevices();
  const before = reg.devices.length;
  reg.devices = reg.devices.filter((d) => d.name !== name);
  if (reg.devices.length === before) return false;
  writeAtomic(reg);
  return true;
}

export function renameDevice(oldName, newName) {
  if (!newName || typeof newName !== 'string') throw new Error('new name required');
  const reg = loadDevices();
  const d = reg.devices.find((x) => x.name === oldName);
  if (!d) return null;
  if (reg.devices.some((x) => x.name === newName && x !== d)) {
    throw new Error(`device already exists: ${newName}`);
  }
  d.name = newName;
  writeAtomic(reg);
  return d;
}

/**
 * Update last_seen for a device. Debounced to one disk write per minute per
 * device so a chatty client (polling SSE, etc.) doesn't constantly rewrite
 * devices.json.
 */
export function updateLastSeen(serialHex) {
  if (!serialHex) return;
  const s = serialHex.toLowerCase();
  const now = Date.now();
  const prev = lastSeenCache.get(s) ?? 0;
  if (now - prev < LAST_SEEN_DEBOUNCE_MS) return;
  const reg = loadDevices();
  const d = reg.devices.find((x) => x.serial_hex === s);
  if (!d) return;
  d.last_seen = new Date(now).toISOString();
  writeAtomic(reg);
  lastSeenCache.set(s, now);
}

// Exposed for tests that want to reset debouncing between runs.
export function _resetLastSeenCache() {
  lastSeenCache.clear();
}
