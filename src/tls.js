/**
 * TLS leaf certificate management for the local hub.
 *
 * The leaf is signed by the local CA (src/ca.js) and covers:
 *   - DNS: scope.local, localhost, and any extra names the caller passes
 *   - IP:  127.0.0.1, ::1, and every non-internal LAN IPv4/IPv6 address
 *
 * Persisted under HUB_DIR/leaf/:
 *   leaf.key, leaf.crt   — current PEMs (key 0600)
 *   leaf.meta.json       — SAN set + notAfter, used to decide whether to
 *                          reissue on next startup
 *
 * Reissue triggers (any of):
 *   - no leaf on disk
 *   - SAN set changed between runs (e.g. LAN IP moved)
 *   - cert is within 30 days of expiry
 *   - cert no longer chains to the current CA (CA was rotated)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { X509Certificate } from 'node:crypto';
import { HUB_DIR, issueLeafCert } from './ca.js';

export const LEAF_DIR = join(HUB_DIR, 'leaf');
export const LEAF_KEY_PATH = join(LEAF_DIR, 'leaf.key');
export const LEAF_CERT_PATH = join(LEAF_DIR, 'leaf.crt');
export const LEAF_META_PATH = join(LEAF_DIR, 'leaf.meta.json');

const RENEW_BEFORE_DAYS = 30;
const LEAF_VALIDITY_DAYS = 90;

/**
 * Collect every reasonable name/IP we want the leaf to validate for.
 * Returns { dnsNames, ipAddresses } — both deduped & sorted for stable
 * comparison across runs.
 */
export function collectSans(extraDns = []) {
  const dns = new Set(['scope.local', 'localhost', ...extraDns]);
  const ips = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) {
      if (i.internal) continue;
      // node-forge's IP encoder only handles plain IPv4/IPv6 — strip zone IDs.
      const addr = (i.address || '').split('%')[0];
      if (addr) ips.add(addr);
    }
  }
  return {
    dnsNames: [...dns].sort(),
    ipAddresses: [...ips].sort(),
  };
}

function sansEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.dnsNames.length === b.dnsNames.length &&
    a.ipAddresses.length === b.ipAddresses.length &&
    a.dnsNames.every((v, i) => v === b.dnsNames[i]) &&
    a.ipAddresses.every((v, i) => v === b.ipAddresses[i])
  );
}

function readMeta() {
  if (!existsSync(LEAF_META_PATH)) return null;
  try { return JSON.parse(readFileSync(LEAF_META_PATH, 'utf8')); }
  catch { return null; }
}

function daysUntil(date) {
  return (new Date(date).getTime() - Date.now()) / (86400 * 1000);
}

/**
 * Decide whether a fresh leaf should be issued.
 *
 * @param {object} args
 * @param {{dnsNames:string[], ipAddresses:string[]}} args.sans
 * @param {{keyPem:string, certPem:string}} args.ca
 * @returns {{reissue:boolean, reason:string}}
 */
export function leafNeedsReissue({ sans, ca }) {
  if (!existsSync(LEAF_KEY_PATH) || !existsSync(LEAF_CERT_PATH)) {
    return { reissue: true, reason: 'no leaf on disk' };
  }
  const meta = readMeta();
  if (!meta) return { reissue: true, reason: 'meta missing/corrupt' };
  if (!sansEqual(meta.sans, sans)) {
    return { reissue: true, reason: 'SAN set changed' };
  }
  if (daysUntil(meta.notAfter) < RENEW_BEFORE_DAYS) {
    return { reissue: true, reason: 'within renewal window' };
  }
  // Verify the cert still chains to the *current* CA (CA may have been
  // regenerated out-of-band).
  try {
    const leafX = new X509Certificate(readFileSync(LEAF_CERT_PATH, 'utf8'));
    const caX = new X509Certificate(ca.certPem);
    if (!leafX.verify(caX.publicKey)) {
      return { reissue: true, reason: 'no longer chains to CA' };
    }
  } catch (e) {
    return { reissue: true, reason: `verify failed: ${e.message}` };
  }
  return { reissue: false, reason: 'current' };
}

/**
 * Ensure a fresh leaf exists for the given SAN set. Returns
 * { keyPem, certPem, sans, notAfter, reissued, reason }.
 */
export function ensureLeafCert({ ca, sans = collectSans() } = {}) {
  if (!existsSync(LEAF_DIR)) mkdirSync(LEAF_DIR, { recursive: true });
  const decision = leafNeedsReissue({ sans, ca });
  if (!decision.reissue) {
    return {
      keyPem: readFileSync(LEAF_KEY_PATH, 'utf8'),
      certPem: readFileSync(LEAF_CERT_PATH, 'utf8'),
      sans,
      notAfter: readMeta()?.notAfter,
      reissued: false,
      reason: decision.reason,
    };
  }
  const leaf = issueLeafCert({
    ca,
    commonName: 'scope.local',
    dnsNames: sans.dnsNames,
    ipAddresses: sans.ipAddresses,
    kind: 'server',
    days: LEAF_VALIDITY_DAYS,
  });
  writeFileSync(LEAF_KEY_PATH, leaf.keyPem);
  try { chmodSync(LEAF_KEY_PATH, 0o600); } catch {}
  writeFileSync(LEAF_CERT_PATH, leaf.certPem);
  try { chmodSync(LEAF_CERT_PATH, 0o644); } catch {}
  const meta = {
    sans,
    notAfter: leaf.notAfter.toISOString(),
    serialHex: leaf.serialHex,
    issuedAt: new Date().toISOString(),
  };
  writeFileSync(LEAF_META_PATH, JSON.stringify(meta, null, 2));
  return { ...leaf, sans, reissued: true, reason: decision.reason };
}
