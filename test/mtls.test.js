/**
 * mTLS integration tests for SCP-56.
 *
 * Spins up a real HTTPS server (no tls:false here — that's the whole point),
 * issues a paired client cert via /api/pair/begin + /api/pair/complete, then
 * makes requests with: (a) the paired cert, (b) an unknown CA-signed cert,
 * (c) no cert + no bearer token, (d) no cert + valid bearer token.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import https from 'node:https';
import forge from 'node-forge';

import { startServer } from '../src/server.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { createTempScope } from './helpers.js';
import { loadOrCreateCa, HUB_DIR, issueLeafCert } from '../src/ca.js';
import { _resetLastSeenCache } from '../src/devices.js';
import { loadOrCreateToken } from '../src/auth.js';

function resetHub() {
  try { rmSync(HUB_DIR, { recursive: true, force: true }); } catch {}
  _resetLastSeenCache();
}

async function startHttpsServer() {
  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const w = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  try { w.db.close(); } catch {}
  w.db = scope.db;
  const server = await startServer({
    workspaces: mgr,
    port: 0,
    silent: true,
    discoverable: false,
    // default tls -> HTTPS with mTLS request
  });
  const port = server.address().port;
  const close = async () => {
    await new Promise((r) => server.close(() => r()));
    scope.cleanup();
  };
  return { server, port, close, ca: server._tls.ca };
}

function httpsRequest({ port, path, ca, key, cert, headers, host = 'scope.local' }) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      ca: ca ? [ca] : undefined,
      key,
      cert,
      servername: host,
      headers: { host: `${host}:${port}`, ...(headers || {}) },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function pairADevice(port, caPem) {
  // 1. begin (loopback bypasses auth, but we still need to hit HTTPS).
  const begin = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1', port, path: '/api/pair/begin', method: 'POST',
        ca: [caPem], servername: 'localhost',
        headers: { 'content-type': 'application/json', 'content-length': '2', host: `localhost:${port}` },
      },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
      }
    );
    req.on('error', reject);
    req.write('{}');
    req.end();
  });
  assert.equal(begin.status, 200, `begin failed: ${JSON.stringify(begin)}`);
  // 2. generate client keypair + CSR
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: 'x' }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  const csrPem = forge.pki.certificationRequestToPem(csr);
  // 3. complete
  const completeBody = JSON.stringify({ code: begin.body.code, csr_pem: csrPem, device_name: 'bri-iphone' });
  const complete = await new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1', port, path: '/api/pair/complete', method: 'POST',
        ca: [caPem], servername: 'localhost',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(completeBody), host: `localhost:${port}` },
      },
      (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
      }
    );
    req.on('error', reject);
    req.write(completeBody);
    req.end();
  });
  assert.equal(complete.status, 201, `complete failed: ${JSON.stringify(complete)}`);
  return { clientKeyPem: forge.pki.privateKeyToPem(keys.privateKey), clientCertPem: complete.body.cert_pem };
}

test('mTLS — request with a paired client cert is authenticated without a bearer token', async () => {
  resetHub();
  const { port, close, ca } = await startHttpsServer();
  try {
    const { clientKeyPem, clientCertPem } = await pairADevice(port, ca.certPem);
    const r = await httpsRequest({
      port, path: '/api/meta',
      ca: ca.certPem, key: clientKeyPem, cert: clientCertPem,
    });
    assert.equal(r.status, 200);
    const meta = JSON.parse(r.body);
    assert.ok(Array.isArray(meta.statuses));
  } finally {
    await close();
  }
});

test('mTLS — bearer-token path still works under HTTPS for browser-style requests', async () => {
  resetHub();
  const { port, close, ca } = await startHttpsServer();
  try {
    const token = loadOrCreateToken();
    const r = await httpsRequest({
      port, path: '/api/meta',
      ca: ca.certPem,
      host: 'scope.local',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200);
  } finally {
    await close();
  }
});

/* ---------- middleware-level tests (LAN socket simulated) ----------
 *
 * The end-to-end tests above run against a real HTTPS server bound to
 * 127.0.0.1, which means the middleware's loopback bypass fires — perfect for
 * "paired cert is accepted" but it makes negative cases (no auth, untrusted
 * cert) impossible to express that way. These tests call authMiddleware
 * directly with a fake socket whose remoteAddress is a LAN IP so the bypass
 * doesn't kick in.
 */

import { authMiddleware, deviceFromPeerCert, lanHosts } from '../src/auth.js';
import { addDevice } from '../src/devices.js';

function fakeReq({ remoteAddress = '192.168.1.50', host = 'scope.local', headers = {}, peerCert, authorized = false } = {}) {
  return {
    headers: { host, ...headers },
    socket: {
      remoteAddress,
      authorized,
      getPeerCertificate() { return peerCert ? { raw: peerCert.raw } : null; },
    },
    query: {},
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    setHeader() {},
  };
}

test('authMiddleware — LAN request with paired client cert → next() (req.device set)', async () => {
  resetHub();
  const ca = loadOrCreateCa();
  const leaf = issueLeafCert({ ca, commonName: 'phone', kind: 'client' });
  const certX = new (await import('node:crypto')).X509Certificate(leaf.certPem);
  // Register the device with its real serial.
  const rec = addDevice({
    name: 'phone',
    certPem: leaf.certPem,
    serialHex: certX.serialNumber.toLowerCase(),
    notAfter: certX.validTo,
  });
  const mw = authMiddleware({ token: 'tok', allowedHosts: lanHosts() });
  let nextCalled = false;
  const req = fakeReq({ peerCert: certX, authorized: true });
  const res = fakeRes();
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.device?.name, rec.name);
});

test('authMiddleware — LAN request with NO cert + NO token → 401', () => {
  resetHub();
  const mw = authMiddleware({ token: 'tok', allowedHosts: lanHosts() });
  const req = fakeReq();
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('authMiddleware — LAN request with valid bearer token → next() (browser path)', () => {
  resetHub();
  const mw = authMiddleware({ token: 'tok', allowedHosts: lanHosts() });
  const req = fakeReq({ headers: { authorization: 'Bearer tok' } });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('authMiddleware — LAN request with CA-signed cert that is NOT in devices.json → 401', async () => {
  resetHub();
  const ca = loadOrCreateCa();
  const leaf = issueLeafCert({ ca, commonName: 'ghost', kind: 'client' });
  const certX = new (await import('node:crypto')).X509Certificate(leaf.certPem);
  // Note: NOT added to devices.json.
  const mw = authMiddleware({ token: 'tok', allowedHosts: lanHosts() });
  const req = fakeReq({ peerCert: certX, authorized: true });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.match(JSON.stringify(res.body), /unknown client certificate/);
});

test('authMiddleware — LAN request with untrusted-CA cert (authorized=false) → falls to bearer path', () => {
  resetHub();
  // Untrusted peer cert (socket.authorized=false) is equivalent to "no cert
  // presented" for auth purposes — falls through to the bearer check.
  const mw = authMiddleware({ token: 'tok', allowedHosts: lanHosts() });
  const req = fakeReq({
    peerCert: { raw: Buffer.from('garbage') },
    authorized: false,
    headers: { authorization: 'Bearer tok' },
  });
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('end-to-end smoke (SCP-58): pair → request OK → revoke + reload → request 401', async () => {
  resetHub();
  const { revokeSerial, reloadCrl } = await import('../src/revocation.js');
  const { removeDevice } = await import('../src/devices.js');

  const { port, close, ca } = await startHttpsServer();
  try {
    const { clientKeyPem, clientCertPem } = await pairADevice(port, ca.certPem);
    // Before revoke
    const okRes = await httpsRequest({
      port, path: '/api/meta', ca: ca.certPem,
      key: clientKeyPem, cert: clientCertPem,
    });
    assert.equal(okRes.status, 200);

    // Revoke by parsing the cert to grab the serial.
    const { X509Certificate } = await import('node:crypto');
    const x = new X509Certificate(clientCertPem);
    revokeSerial({ serialHex: x.serialNumber.toLowerCase(), name: 'bri-iphone' });
    removeDevice('bri-iphone');
    reloadCrl(); // in-process; SIGUSR1 path is exercised separately

    const denied = await httpsRequest({
      port, path: '/api/meta', ca: ca.certPem,
      key: clientKeyPem, cert: clientCertPem,
    });
    assert.equal(denied.status, 401);
    assert.match(denied.body, /certificate revoked|unknown client certificate/);
  } finally {
    await close();
  }
});

test('deviceFromPeerCert — returns the device record for a matching cert serial', async () => {
  resetHub();
  const ca = loadOrCreateCa();
  const leaf = issueLeafCert({ ca, commonName: 'lookup-test', kind: 'client' });
  const certX = new (await import('node:crypto')).X509Certificate(leaf.certPem);
  addDevice({
    name: 'lookup-test',
    certPem: leaf.certPem,
    serialHex: certX.serialNumber.toLowerCase(),
    notAfter: certX.validTo,
  });
  const d = deviceFromPeerCert(certX);
  assert.equal(d?.name, 'lookup-test');
});
