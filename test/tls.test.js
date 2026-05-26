import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import https from 'node:https';

import { loadOrCreateCa, HUB_DIR, issueLeafCert } from '../src/ca.js';
import {
  ensureLeafCert,
  collectSans,
  leafNeedsReissue,
  LEAF_KEY_PATH,
  LEAF_CERT_PATH,
  LEAF_META_PATH,
  LEAF_DIR,
} from '../src/tls.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';
import { createTempScope } from './helpers.js';

function resetHub() {
  try { rmSync(HUB_DIR, { recursive: true, force: true }); } catch {}
}

test('ensureLeafCert generates a leaf chained to the CA with expected SANs', () => {
  resetHub();
  const ca = loadOrCreateCa();
  const sans = collectSans();
  // scope.local + localhost + 127.0.0.1 + ::1 should always appear
  assert.ok(sans.dnsNames.includes('scope.local'));
  assert.ok(sans.dnsNames.includes('localhost'));
  assert.ok(sans.ipAddresses.includes('127.0.0.1'));

  const leaf = ensureLeafCert({ ca, sans });
  assert.equal(leaf.reissued, true);
  assert.ok(existsSync(LEAF_KEY_PATH));
  assert.ok(existsSync(LEAF_CERT_PATH));
  assert.ok(existsSync(LEAF_META_PATH));
  // key must be 0600
  const keyMode = statSync(LEAF_KEY_PATH).mode & 0o777;
  assert.equal(keyMode, 0o600);

  const x = new X509Certificate(leaf.certPem);
  const caX = new X509Certificate(ca.certPem);
  assert.ok(x.verify(caX.publicKey));
  // 90-day validity
  const days = (new Date(x.validTo).getTime() - Date.now()) / (86400 * 1000);
  assert.ok(days > 80 && days < 95, `expected ~90d, got ${days.toFixed(1)}`);
});

test('ensureLeafCert is idempotent when SANs unchanged and not near expiry', () => {
  resetHub();
  const ca = loadOrCreateCa();
  const first = ensureLeafCert({ ca });
  const second = ensureLeafCert({ ca });
  assert.equal(first.reissued, true);
  assert.equal(second.reissued, false);
  assert.equal(first.certPem, readFileSync(LEAF_CERT_PATH, 'utf8'));
});

test('ensureLeafCert reissues when the SAN set changes', () => {
  resetHub();
  const ca = loadOrCreateCa();
  const sans1 = { dnsNames: ['scope.local', 'localhost'], ipAddresses: ['127.0.0.1'] };
  const first = ensureLeafCert({ ca, sans: sans1 });
  assert.equal(first.reissued, true);

  const sans2 = { dnsNames: ['scope.local', 'localhost'], ipAddresses: ['127.0.0.1', '192.168.1.42'] };
  const second = ensureLeafCert({ ca, sans: sans2 });
  assert.equal(second.reissued, true);
  assert.notEqual(first.certPem, second.certPem);
});

test('leafNeedsReissue trips when cert is within the renewal window', () => {
  resetHub();
  const ca = loadOrCreateCa();
  const sans = collectSans();
  // Issue an "old" leaf manually with only 10 days left.
  const old = issueLeafCert({
    ca,
    commonName: 'scope.local',
    dnsNames: sans.dnsNames,
    ipAddresses: sans.ipAddresses,
    kind: 'server',
    days: 10,
  });
  writeFakeLeaf(old.keyPem, old.certPem, sans, old.notAfter);

  const decision = leafNeedsReissue({ sans, ca });
  assert.equal(decision.reissue, true);
  assert.match(decision.reason, /renewal/);
});

// Helper that writes a fake leaf into the expected files without going through
// ensureLeafCert. Lets us simulate edge cases (near-expiry, SAN drift, etc.).
function writeFakeLeaf(keyPem, certPem, sans, notAfter) {
  if (!existsSync(LEAF_DIR)) mkdirSync(LEAF_DIR, { recursive: true });
  writeFileSync(LEAF_KEY_PATH, keyPem);
  writeFileSync(LEAF_CERT_PATH, certPem);
  writeFileSync(
    LEAF_META_PATH,
    JSON.stringify({ sans, notAfter: new Date(notAfter).toISOString() }, null, 2)
  );
}

test('startServer serves HTTPS using the local CA leaf by default', async () => {
  resetHub();
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
    // default tls -> HTTPS using the local CA
  });
  try {
    const port = server.address().port;
    const caPem = readFileSync(`${HUB_DIR}/ca/ca.crt`, 'utf8');
    // Talk to it over HTTPS using the CA as a trust anchor. servername must be
    // a SAN; loopback is.
    const body = await new Promise((resolve, reject) => {
      const req = https.get(
        {
          host: '127.0.0.1',
          port,
          path: '/api/meta',
          ca: caPem,
          // 127.0.0.1 is in the leaf's SAN list, so cert validation should pass
          servername: 'localhost',
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { data += c; });
          res.on('end', () => resolve({ status: res.statusCode, data }));
        }
      );
      req.on('error', reject);
    });
    assert.equal(body.status, 200);
    const json = JSON.parse(body.data);
    assert.ok(Array.isArray(json.statuses));
    // SCP-57: HTTPS hub advertises mtls + ca_fp.
    assert.equal(json.security.scheme, 'https');
    assert.ok(json.security.auth.includes('mtls'));
    assert.match(json.security.ca_fingerprint, /^[0-9a-f]{64}$/);
  } finally {
    await new Promise((r) => server.close(() => r()));
    scope.cleanup();
  }
});
