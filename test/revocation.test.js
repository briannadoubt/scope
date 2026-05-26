import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

import {
  revokeSerial,
  unrevokeSerial,
  isRevoked,
  listRevoked,
  reloadCrl,
  _resetCrlCache,
  REVOKED_PATH,
} from '../src/revocation.js';
import { loadOrCreateCa, HUB_DIR, issueLeafCert } from '../src/ca.js';
import { addDevice, _resetLastSeenCache } from '../src/devices.js';
import { authMiddleware, lanHosts, deviceFromPeerCert } from '../src/auth.js';

function reset() {
  try { rmSync(HUB_DIR, { recursive: true, force: true }); } catch {}
  _resetCrlCache();
  _resetLastSeenCache();
}

test('revokeSerial / unrevokeSerial / listRevoked round-trip', () => {
  reset();
  revokeSerial({ serialHex: '00ABCD', name: 'phone' });
  assert.equal(listRevoked().length, 1);
  assert.equal(listRevoked()[0].serial_hex, '00abcd');
  // Idempotent: revoke twice doesn't add a second entry.
  revokeSerial({ serialHex: '00abcd', name: 'phone' });
  assert.equal(listRevoked().length, 1);
  // Unrevoke
  assert.equal(unrevokeSerial('00ABCD'), true);
  assert.equal(listRevoked().length, 0);
  assert.equal(unrevokeSerial('00abcd'), false);
});

test('isRevoked uses the in-memory cache and lazy-loads', () => {
  reset();
  // Not loaded → cold call returns false.
  assert.equal(isRevoked('feed'), false);
  revokeSerial({ serialHex: 'feed' });
  assert.equal(isRevoked('FEED'), true);
});

test('reloadCrl picks up disk changes (simulates SIGUSR1 path)', () => {
  reset();
  reloadCrl(); // empty
  assert.equal(isRevoked('beef'), false);
  // A different process writes to revoked.json (we simulate by calling
  // revokeSerial which also reloads internally, but isRevoked already cached
  // empty — assert the reloadCrl call in revokeSerial picks it up).
  revokeSerial({ serialHex: 'beef' });
  assert.equal(isRevoked('beef'), true);
});

test('authMiddleware refuses a revoked client cert with "certificate revoked"', async () => {
  reset();
  const ca = loadOrCreateCa();
  const leaf = issueLeafCert({ ca, commonName: 'pwned', kind: 'client' });
  const certX = new (await import('node:crypto')).X509Certificate(leaf.certPem);
  const serial = certX.serialNumber.toLowerCase();
  addDevice({ name: 'pwned', certPem: leaf.certPem, serialHex: serial, notAfter: certX.validTo });

  // First pass: paired device works.
  const mw = authMiddleware({ token: 'tok', allowedHosts: lanHosts() });
  const fakeReq = {
    headers: { host: 'scope.local' },
    socket: { remoteAddress: '192.168.1.5', authorized: true, getPeerCertificate() { return { raw: certX.raw }; } },
    query: {},
  };
  let ok = false;
  mw(fakeReq, fakeRes(), () => { ok = true; });
  assert.equal(ok, true);

  // Now revoke and try again.
  revokeSerial({ serialHex: serial, name: 'pwned' });
  const res = fakeRes();
  ok = false;
  mw(fakeReq, res, () => { ok = true; });
  assert.equal(ok, false);
  assert.equal(res.statusCode, 401);
  assert.match(JSON.stringify(res.body), /certificate revoked/);
});

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() {},
  };
}
