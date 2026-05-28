/**
 * Local certificate authority for Scope's mTLS / native-client story.
 *
 * Responsibilities:
 *  - Generate a self-signed root CA on first run, persist to ~/.scope-hub/ca/
 *    (key = mode 0600, cert = 0644). 10-year validity.
 *  - Idempotent loader: subsequent calls return the existing CA without
 *    regenerating.
 *  - Issue leaf server / client certs signed by the CA.
 *  - Expose the SHA-256 fingerprint of the CA cert so the user can verify
 *    out-of-band when pairing devices.
 *
 * Layout under HUB_DIR (~/.scope-hub):
 *   ca/
 *     ca.key       (PEM, 0600)
 *     ca.crt       (PEM, 0644)
 *   devices.json   (managed by pairing/device modules; created lazily)
 *   revoked.json   (managed by revocation; created lazily)
 *
 * We use node-forge for X.509 generation — Node's built-in crypto can parse
 * X.509 (X509Certificate) but cannot create them. node-forge is pure JS, zero
 * deps, and avoids the openssl shell-out the ticket explicitly forbids.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash, X509Certificate } from 'node:crypto';
import forge from 'node-forge';

export const HUB_DIR = join(homedir(), '.scope-hub');
export const CA_DIR = join(HUB_DIR, 'ca');
export const CA_KEY_PATH = join(CA_DIR, 'ca.key');
export const CA_CERT_PATH = join(CA_DIR, 'ca.crt');

const CA_VALIDITY_YEARS = 10;
const DEFAULT_LEAF_DAYS = 90;

/**
 * Ensure HUB_DIR and CA_DIR exist. Safe to call repeatedly.
 */
export function ensureHubDir() {
  if (!existsSync(HUB_DIR)) mkdirSync(HUB_DIR, { recursive: true });
  if (!existsSync(CA_DIR)) mkdirSync(CA_DIR, { recursive: true });
}

function randomSerialHex() {
  // 16 random bytes → 128-bit serial. Clear the high bit of the first byte so
  // the ASN.1 INTEGER is always positive without a leading 00 pad byte.
  // Node 24 / OpenSSL 3.5 rejects unconditional 00 prefixes as illegal padding
  // when the following byte's high bit is already 0.
  const bytes = forge.random.getBytesSync(16);
  const hex = forge.util.bytesToHex(bytes);
  const first = (parseInt(hex.slice(0, 2), 16) & 0x7f).toString(16).padStart(2, '0');
  return first + hex.slice(2);
}

function caSubject() {
  return [
    { name: 'commonName', value: 'Scope Local CA' },
    { name: 'organizationName', value: 'Scope' },
    { name: 'organizationalUnitName', value: 'Local Hub' },
  ];
}

/**
 * Generate a new self-signed root CA. Returns { keyPem, certPem }.
 * Does not write to disk — caller decides.
 */
export function generateCa({ now = new Date() } = {}) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = new Date(now.getTime() - 5 * 60 * 1000); // 5min skew
  cert.validity.notAfter = new Date(now.getTime());
  cert.validity.notAfter.setFullYear(
    cert.validity.notAfter.getFullYear() + CA_VALIDITY_YEARS
  );
  const subject = caSubject();
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    {
      name: 'keyUsage',
      keyCertSign: true,
      cRLSign: true,
      digitalSignature: true,
      critical: true,
    },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
  };
}

/**
 * Load the CA from disk if it exists, or generate + persist a fresh one.
 * Returns { keyPem, certPem, fingerprint, created }.
 *
 * `created: true` indicates this call generated a new CA — callers (the
 * `serve` banner) can use that to print the fingerprint prominently on first
 * run.
 */
export function loadOrCreateCa() {
  ensureHubDir();
  if (existsSync(CA_KEY_PATH) && existsSync(CA_CERT_PATH)) {
    const keyPem = readFileSync(CA_KEY_PATH, 'utf8');
    const certPem = readFileSync(CA_CERT_PATH, 'utf8');
    // Best-effort permission repair — if the key somehow ended up world-
    // readable, lock it back down. Don't fail if chmod isn't supported.
    try {
      const mode = statSync(CA_KEY_PATH).mode & 0o777;
      if (mode !== 0o600) chmodSync(CA_KEY_PATH, 0o600);
    } catch {}
    return {
      keyPem,
      certPem,
      fingerprint: fingerprintPem(certPem),
      created: false,
    };
  }
  const { keyPem, certPem } = generateCa();
  writeFileSync(CA_KEY_PATH, keyPem);
  try { chmodSync(CA_KEY_PATH, 0o600); } catch {}
  writeFileSync(CA_CERT_PATH, certPem);
  try { chmodSync(CA_CERT_PATH, 0o644); } catch {}
  return {
    keyPem,
    certPem,
    fingerprint: fingerprintPem(certPem),
    created: true,
  };
}

/**
 * SHA-256 fingerprint of a PEM-encoded cert, formatted as the conventional
 * uppercase colon-separated hex (e.g. "AB:CD:..."). This matches what
 * `openssl x509 -fingerprint -sha256` prints, and what users see in Keychain.
 */
export function fingerprintPem(certPem) {
  const cert = new X509Certificate(certPem);
  const der = cert.raw; // Buffer of DER bytes
  const hex = createHash('sha256').update(der).digest('hex').toUpperCase();
  return hex.match(/.{2}/g).join(':');
}

/** Compact lowercase fingerprint for TXT records and URL params. */
export function fingerprintHex(certPem) {
  return fingerprintPem(certPem).replace(/:/g, '').toLowerCase();
}

/**
 * Issue a leaf cert signed by the CA.
 *
 * @param {object} opts
 * @param {{keyPem:string, certPem:string}} opts.ca       - the CA
 * @param {string}   opts.commonName                       - leaf CN
 * @param {string[]} [opts.dnsNames=[]]                    - DNS SANs
 * @param {string[]} [opts.ipAddresses=[]]                 - IP SANs
 * @param {'server'|'client'} [opts.kind='server']         - EKU shape
 * @param {number}   [opts.days=DEFAULT_LEAF_DAYS]         - validity in days
 * @param {Date}     [opts.now=new Date()]
 * @returns {{keyPem:string, certPem:string, serialHex:string, notAfter:Date}}
 */
export function issueLeafCert({
  ca,
  commonName,
  dnsNames = [],
  ipAddresses = [],
  kind = 'server',
  days = DEFAULT_LEAF_DAYS,
  now = new Date(),
}) {
  if (!ca?.keyPem || !ca?.certPem) throw new Error('issueLeafCert: ca required');
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const caCert = forge.pki.certificateFromPem(ca.certPem);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = new Date(now.getTime() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(now.getTime() + days * 86400 * 1000);
  cert.setSubject([{ name: 'commonName', value: commonName }]);
  cert.setIssuer(caCert.subject.attributes);

  const altNames = [
    ...dnsNames.map((d) => ({ type: 2, value: d })), // dNSName
    ...ipAddresses.map((ip) => ({ type: 7, ip })),    // iPAddress
  ];

  const extensions = [
    { name: 'basicConstraints', cA: false, critical: true },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    {
      name: 'extKeyUsage',
      serverAuth: kind === 'server',
      clientAuth: kind === 'client' || kind === 'server' ? kind === 'client' || false : false,
    },
    { name: 'subjectKeyIdentifier' },
  ];
  // Replace EKU with an explicit, accurate set — the inline expression above
  // is hard to read; do it cleanly here.
  extensions[2] = {
    name: 'extKeyUsage',
    serverAuth: kind === 'server',
    clientAuth: kind === 'client',
  };
  if (altNames.length) {
    extensions.push({ name: 'subjectAltName', altNames });
  }
  cert.setExtensions(extensions);
  cert.sign(caKey, forge.md.sha256.create());

  return {
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certPem: forge.pki.certificateToPem(cert),
    serialHex: cert.serialNumber.toLowerCase(),
    notAfter: cert.validity.notAfter,
  };
}

/**
 * Sign a PKCS#10 CSR with the CA, producing a client cert.
 * Used by the pairing endpoint — the client generates its own keypair, sends
 * us only the public key inside the CSR, and we never see the private key.
 *
 * @param {object} opts
 * @param {{keyPem:string, certPem:string}} opts.ca
 * @param {string} opts.csrPem
 * @param {string} opts.commonName    - we override the subject CN with the
 *                                       device name so it's authoritative
 * @param {number} [opts.days=DEFAULT_LEAF_DAYS]
 * @param {Date}   [opts.now=new Date()]
 * @returns {{certPem:string, serialHex:string, notAfter:Date}}
 */
export function signCsr({
  ca,
  csrPem,
  commonName,
  days = DEFAULT_LEAF_DAYS,
  now = new Date(),
}) {
  if (!ca?.keyPem || !ca?.certPem) throw new Error('signCsr: ca required');
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  if (!csr.verify()) throw new Error('CSR signature invalid');

  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);
  const caCert = forge.pki.certificateFromPem(ca.certPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = new Date(now.getTime() - 5 * 60 * 1000);
  cert.validity.notAfter = new Date(now.getTime() + days * 86400 * 1000);
  cert.setSubject([{ name: 'commonName', value: commonName }]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    {
      name: 'keyUsage',
      digitalSignature: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: 'extKeyUsage', clientAuth: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  return {
    certPem: forge.pki.certificateToPem(cert),
    serialHex: cert.serialNumber.toLowerCase(),
    notAfter: cert.validity.notAfter,
  };
}
