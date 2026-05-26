import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, rmSync, readFileSync } from 'node:fs';
import { X509Certificate, createPrivateKey, createPublicKey, createSign, createVerify } from 'node:crypto';
import forge from 'node-forge';

import {
  loadOrCreateCa,
  fingerprintPem,
  fingerprintHex,
  issueLeafCert,
  signCsr,
  CA_DIR,
  CA_KEY_PATH,
  CA_CERT_PATH,
  HUB_DIR,
} from '../src/ca.js';

// Each test resets the CA dir so they're independent.
function resetCa() {
  try { rmSync(HUB_DIR, { recursive: true, force: true }); } catch {}
}

test('loadOrCreateCa generates a new CA on first run with correct file modes', () => {
  resetCa();
  const c = loadOrCreateCa();
  assert.equal(c.created, true);
  assert.ok(existsSync(CA_KEY_PATH));
  assert.ok(existsSync(CA_CERT_PATH));
  assert.match(c.keyPem, /BEGIN (RSA )?PRIVATE KEY/);
  assert.match(c.certPem, /BEGIN CERTIFICATE/);
  // mode 0600 on the key
  const keyMode = statSync(CA_KEY_PATH).mode & 0o777;
  assert.equal(keyMode, 0o600, `expected 0600, got 0${keyMode.toString(8)}`);
});

test('loadOrCreateCa is idempotent — second call reuses the same CA', () => {
  resetCa();
  const a = loadOrCreateCa();
  const b = loadOrCreateCa();
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(b.created, false);
  assert.equal(a.certPem, b.certPem);
});

test('CA certificate is self-signed, CA:TRUE, and valid for ~10 years', () => {
  resetCa();
  const c = loadOrCreateCa();
  const cert = new X509Certificate(c.certPem);
  // self-signed
  assert.equal(cert.subject, cert.issuer);
  // Check CA:TRUE in basic constraints
  assert.ok(cert.ca === true || /CA:TRUE/i.test(cert.toString()));
  // Validity around 10 years
  const ms = new Date(cert.validTo).getTime() - new Date(cert.validFrom).getTime();
  const years = ms / (365.25 * 86400 * 1000);
  assert.ok(years > 9.9 && years < 10.1, `validity should be ~10y, got ${years.toFixed(2)}`);
});

test('fingerprintPem matches the expected colon-separated uppercase hex', () => {
  resetCa();
  const c = loadOrCreateCa();
  const fp = fingerprintPem(c.certPem);
  assert.match(fp, /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  assert.equal(fp, c.fingerprint);
  // compact form for TXT/url is lowercase no-colon
  assert.equal(fingerprintHex(c.certPem), fp.replace(/:/g, '').toLowerCase());
});

test('issueLeafCert produces a cert chained to the CA with the right SANs', () => {
  resetCa();
  const ca = loadOrCreateCa();
  const leaf = issueLeafCert({
    ca,
    commonName: 'scope.local',
    dnsNames: ['scope.local', 'localhost'],
    ipAddresses: ['127.0.0.1'],
    kind: 'server',
  });
  const leafX = new X509Certificate(leaf.certPem);
  const caX = new X509Certificate(ca.certPem);
  // Issued by the CA
  assert.equal(leafX.issuer, caX.subject);
  // Chain verifies
  assert.ok(leafX.verify(caX.publicKey));
  // SAN strings present
  const san = leafX.subjectAltName || '';
  assert.match(san, /DNS:scope\.local/);
  assert.match(san, /DNS:localhost/);
  assert.match(san, /IP Address:127\.0\.0\.1/);
});

test('signCsr signs an externally-generated CSR and produces a clientAuth cert', () => {
  resetCa();
  const ca = loadOrCreateCa();
  // Generate a fresh keypair + CSR via forge (simulates the SwiftUI client).
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: 'ignored-will-be-overridden' }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const csrPem = forge.pki.certificationRequestToPem(csr);

  const signed = signCsr({ ca, csrPem, commonName: 'bri-iphone' });
  const certX = new X509Certificate(signed.certPem);
  const caX = new X509Certificate(ca.certPem);

  // chained to CA
  assert.ok(certX.verify(caX.publicKey));
  // CN is what we asked for, not what the CSR claimed
  assert.match(certX.subject, /CN=bri-iphone/);
  // serial round-trips as lowercase hex
  assert.match(signed.serialHex, /^[0-9a-f]+$/);
  // EKU includes clientAuth — parse with forge and check the extension.
  const fCert = forge.pki.certificateFromPem(signed.certPem);
  const eku = fCert.getExtension('extKeyUsage');
  assert.ok(eku, 'expected an extKeyUsage extension');
  assert.equal(eku.clientAuth, true);
  assert.notEqual(eku.serverAuth, true);
});

test('signCsr rejects a CSR with a tampered signature', () => {
  resetCa();
  const ca = loadOrCreateCa();
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: 'x' }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  let csrPem = forge.pki.certificationRequestToPem(csr);
  // Flip a byte inside the base64 body to corrupt the signature.
  const lines = csrPem.split('\n');
  const mid = Math.floor(lines.length / 2);
  lines[mid] = lines[mid].split('').reverse().join('');
  csrPem = lines.join('\n');
  assert.throws(() => signCsr({ ca, csrPem, commonName: 'x' }));
});
