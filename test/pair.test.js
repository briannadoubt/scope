import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import forge from 'node-forge';

import { PendingCodes, RateLimiter, generateCode } from '../src/pair.js';
import { loadOrCreateCa, HUB_DIR } from '../src/ca.js';
import {
  addDevice,
  listDevices,
  removeDevice,
  renameDevice,
  findDeviceBySerial,
  updateLastSeen,
  _resetLastSeenCache,
} from '../src/devices.js';
import { startTestServer, apiFetch } from './helpers.js';

function resetHub() {
  try { rmSync(HUB_DIR, { recursive: true, force: true }); } catch {}
  _resetLastSeenCache();
}

/* ---------- pair.js unit tests ---------- */

test('generateCode returns a 6-digit zero-padded string', () => {
  for (let i = 0; i < 50; i++) {
    const c = generateCode();
    assert.match(c, /^\d{6}$/);
  }
});

test('PendingCodes.issue/consume — happy path resolves the waitFor promise', async () => {
  const p = new PendingCodes();
  const { code, waitFor } = p.issue();
  const ee = p.consume(code);
  assert.ok(ee, 'consume should return the EE');
  ee.emit('consumed', { ok: true });
  const result = await waitFor;
  assert.deepEqual(result, { ok: true });
  assert.equal(p.size(), 0);
});

test('PendingCodes — wrong code returns null and does not consume', () => {
  const p = new PendingCodes();
  p.issue();
  assert.equal(p.consume('000000'), null);
  assert.equal(p.size(), 1);
});

test('PendingCodes — codes are single-use', () => {
  const p = new PendingCodes();
  const { code } = p.issue();
  assert.ok(p.consume(code));
  assert.equal(p.consume(code), null);
});

test('PendingCodes — expiry rejects the waitFor promise and drops the code', async () => {
  const p = new PendingCodes();
  const { code, waitFor } = p.issue({ now: 0 });
  // Force sweep "now" to past the TTL
  p.sweep(Date.now() + 10 * 60 * 1000);
  await assert.rejects(waitFor, /expired/);
  assert.equal(p.consume(code), null);
});

test('RateLimiter blocks after 5 attempts within the window', () => {
  const rl = new RateLimiter();
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) {
    assert.equal(rl.check('1.2.3.4', { now: now + i * 100 }).allowed, true);
  }
  const blocked = rl.check('1.2.3.4', { now: now + 600 });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  // Other IPs unaffected
  assert.equal(rl.check('5.6.7.8', { now: now + 600 }).allowed, true);
});

/* ---------- devices.js ---------- */

test('addDevice / listDevices / removeDevice round-trip via devices.json', () => {
  resetHub();
  const ca = loadOrCreateCa();
  const keys = forge.pki.rsa.generateKeyPair(1024); // fast for tests
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '00ff';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: 'commonName', value: 'x' }]);
  cert.setIssuer([{ name: 'commonName', value: 'Scope Local CA' }]);
  cert.sign(forge.pki.privateKeyFromPem(ca.keyPem), forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);

  const rec = addDevice({ name: 'phone', certPem, serialHex: '00FF', notAfter: cert.validity.notAfter });
  assert.equal(rec.name, 'phone');
  assert.equal(rec.serial_hex, '00ff'); // normalized lowercase
  assert.ok(rec.fingerprint.match(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/));

  assert.equal(listDevices().length, 1);
  assert.equal(findDeviceBySerial('00FF')?.name, 'phone');

  // Re-pair with the same name replaces the prior cert (different serial).
  const rec2 = addDevice({ name: 'phone', certPem, serialHex: 'aaaa', notAfter: cert.validity.notAfter });
  assert.equal(listDevices().length, 1);
  assert.equal(listDevices()[0].serial_hex, 'aaaa');

  // Rename
  renameDevice('phone', 'bri-phone');
  assert.equal(listDevices()[0].name, 'bri-phone');

  // Remove
  assert.equal(removeDevice('bri-phone'), true);
  assert.equal(listDevices().length, 0);
  assert.equal(removeDevice('bri-phone'), false);
});

test('updateLastSeen is debounced — only one write per minute per device', () => {
  resetHub();
  const ca = loadOrCreateCa();
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0001';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  cert.setSubject([{ name: 'commonName', value: 'x' }]);
  cert.setIssuer([{ name: 'commonName', value: 'Scope Local CA' }]);
  cert.sign(forge.pki.privateKeyFromPem(ca.keyPem), forge.md.sha256.create());
  const certPem = forge.pki.certificateToPem(cert);
  addDevice({ name: 'd', certPem, serialHex: '0001', notAfter: cert.validity.notAfter });

  updateLastSeen('0001');
  const first = listDevices()[0].last_seen;
  // Immediate second call should be a no-op (debounced).
  updateLastSeen('0001');
  assert.equal(listDevices()[0].last_seen, first);
});

/* ---------- end-to-end pairing over HTTP ---------- */

async function startPairingServer() {
  // The pair endpoints live on the same server.js as the rest of the API.
  // startTestServer uses tls:false so we can hit it with plain fetch and skip
  // the self-signed cert dance — the pairing logic itself is transport-
  // independent.
  return startTestServer();
}

test('POST /api/pair/begin issues a 6-digit code (loopback only)', async () => {
  resetHub();
  const t = await startPairingServer();
  try {
    const r = await apiFetch(t.baseUrl, '/api/pair/begin', { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.match(r.data.code, /^\d{6}$/);
    assert.ok(r.data.ttl_ms > 0);
  } finally {
    await t.close();
  }
});

test('POST /api/pair/complete signs the CSR, persists the device, returns cert + ca', async () => {
  resetHub();
  const t = await startPairingServer();
  try {
    const begin = await apiFetch(t.baseUrl, '/api/pair/begin', { method: 'POST', body: {} });
    const code = begin.data.code;

    // Generate a fresh keypair + CSR client-side.
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: 'doesntmatter' }]);
    csr.sign(keys.privateKey, forge.md.sha256.create());
    const csrPem = forge.pki.certificationRequestToPem(csr);

    const r = await apiFetch(t.baseUrl, '/api/pair/complete', {
      method: 'POST',
      body: { code, csr_pem: csrPem, device_name: 'bri-iphone' },
    });
    assert.equal(r.status, 201);
    assert.match(r.data.cert_pem, /BEGIN CERTIFICATE/);
    assert.match(r.data.ca_pem, /BEGIN CERTIFICATE/);
    assert.equal(r.data.device.name, 'bri-iphone');
    // Persistence
    assert.equal(listDevices().some((d) => d.name === 'bri-iphone'), true);
  } finally {
    await t.close();
  }
});

test('POST /api/pair/complete rejects a bad code with 401', async () => {
  resetHub();
  const t = await startPairingServer();
  try {
    await apiFetch(t.baseUrl, '/api/pair/begin', { method: 'POST', body: {} });
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: 'x' }]);
    csr.sign(keys.privateKey, forge.md.sha256.create());
    const csrPem = forge.pki.certificationRequestToPem(csr);

    const r = await apiFetch(t.baseUrl, '/api/pair/complete', {
      method: 'POST',
      body: { code: '000000', csr_pem: csrPem, device_name: 'x' },
    });
    assert.equal(r.status, 401);
  } finally {
    await t.close();
  }
});

test('POST /api/pair/complete is single-use — second attempt with same code is 401', async () => {
  resetHub();
  const t = await startPairingServer();
  try {
    const begin = await apiFetch(t.baseUrl, '/api/pair/begin', { method: 'POST', body: {} });
    const code = begin.data.code;
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: 'x' }]);
    csr.sign(keys.privateKey, forge.md.sha256.create());
    const csrPem = forge.pki.certificationRequestToPem(csr);

    const ok = await apiFetch(t.baseUrl, '/api/pair/complete', {
      method: 'POST', body: { code, csr_pem: csrPem, device_name: 'a' },
    });
    assert.equal(ok.status, 201);
    const replay = await apiFetch(t.baseUrl, '/api/pair/complete', {
      method: 'POST', body: { code, csr_pem: csrPem, device_name: 'b' },
    });
    assert.equal(replay.status, 401);
  } finally {
    await t.close();
  }
});

test('POST /api/pair/complete rate-limits to 5 attempts per minute per IP', async () => {
  resetHub();
  const t = await startPairingServer();
  try {
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: 'x' }]);
    csr.sign(keys.privateKey, forge.md.sha256.create());
    const csrPem = forge.pki.certificationRequestToPem(csr);

    // 5 bad-code attempts: all should hit the auth check (401), not the
    // rate limiter (429) — the limiter counts all attempts regardless of
    // outcome, so the 6th should be 429.
    for (let i = 0; i < 5; i++) {
      const r = await apiFetch(t.baseUrl, '/api/pair/complete', {
        method: 'POST', body: { code: '000000', csr_pem: csrPem, device_name: 'x' },
      });
      assert.equal(r.status, 401);
    }
    const sixth = await apiFetch(t.baseUrl, '/api/pair/complete', {
      method: 'POST', body: { code: '000000', csr_pem: csrPem, device_name: 'x' },
    });
    assert.equal(sixth.status, 429);
  } finally {
    await t.close();
  }
});
