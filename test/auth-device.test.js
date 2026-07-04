import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import express from 'express';

import {
  approveDeviceGrant,
  issueDeviceGrant,
  normalizeUserCode,
  pollDeviceGrant,
} from '../src/auth_hosted/device-auth.js';
import { publicAuthRouter } from '../src/auth_hosted/cloud-auth.js';
import { mintAccessToken } from '../src/auth_hosted/sessions.js';

class MemoryAuthPool {
  constructor() {
    this.deviceGrants = [];
    this.apiKeys = [];
  }

  async query(sql, params = []) {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.startsWith('INSERT INTO device_auth_grants')) {
      const [id, deviceHash, userHash, clientName, createdAt, expiresAt] = params;
      if (this.deviceGrants.some((g) => g.user_code_hash === userHash)) {
        const err = new Error('duplicate user code');
        err.code = '23505';
        throw err;
      }
      this.deviceGrants.push({
        id,
        device_code_hash: deviceHash,
        user_code_hash: userHash,
        client_name: clientName,
        account_id: null,
        api_key_id: null,
        api_key_plaintext: null,
        created_at: createdAt,
        expires_at: expiresAt,
        approved_at: null,
        consumed_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (compact.startsWith('SELECT * FROM device_auth_grants WHERE user_code_hash=$1')) {
      return { rows: this.deviceGrants.filter((g) => g.user_code_hash === params[0]) };
    }
    if (compact.startsWith('SELECT * FROM device_auth_grants WHERE device_code_hash=$1')) {
      return { rows: this.deviceGrants.filter((g) => g.device_code_hash === params[0]) };
    }
    if (compact.startsWith('UPDATE device_auth_grants SET account_id=$2')) {
      const [id, accountId, apiKeyId, apiKeyPlaintext, approvedAt] = params;
      const row = this.deviceGrants.find((g) => g.id === id);
      Object.assign(row, {
        account_id: accountId,
        api_key_id: apiKeyId,
        api_key_plaintext: apiKeyPlaintext,
        approved_at: approvedAt,
      });
      return { rows: [], rowCount: 1 };
    }
    if (compact.startsWith('UPDATE device_auth_grants SET consumed_at=$2')) {
      const [id, consumedAt] = params;
      const row = this.deviceGrants.find((g) => g.id === id);
      row.consumed_at = consumedAt;
      row.api_key_plaintext = null;
      return { rows: [], rowCount: 1 };
    }
    if (compact.startsWith('INSERT INTO api_keys')) {
      const [id, accountId, name, hash, tenantId, createdAt] = params;
      this.apiKeys.push({
        id,
        account_id: accountId,
        name,
        key_hash: hash,
        tenant_id: tenantId,
        created_at: createdAt,
        revoked_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (compact === 'BEGIN' || compact === 'COMMIT' || compact === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected SQL in MemoryAuthPool: ${compact}`);
  }
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${stderr || stdout}`));
    }, 5000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

test('device auth grant approves once and only reveals the key to the polling device', async () => {
  const pool = new MemoryAuthPool();
  const issued = await issueDeviceGrant(pool, {
    clientName: 'Codex on Bri Mac',
    now: Date.parse('2026-07-04T10:00:00.000Z'),
  });

  assert.match(issued.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(issued.deviceCode, /^sdc_[A-Za-z0-9_-]{32,}$/);
  assert.equal(pool.deviceGrants[0].api_key_plaintext, null);
  assert.deepEqual(await pollDeviceGrant(pool, { deviceCode: issued.deviceCode, now: issued.now }), {
    status: 'pending',
    intervalMs: issued.intervalMs,
  });

  const approved = await approveDeviceGrant(pool, {
    userCode: issued.userCode.toLowerCase().replace('-', ' '),
    accountId: 'acct_bri',
    now: Date.parse('2026-07-04T10:01:00.000Z'),
  });
  assert.equal(approved.status, 'approved');
  assert.equal(pool.apiKeys.length, 1);
  assert.equal(pool.apiKeys[0].account_id, 'acct_bri');
  assert.match(pool.deviceGrants[0].api_key_plaintext, /^sk_/);

  const polled = await pollDeviceGrant(pool, {
    deviceCode: issued.deviceCode,
    now: Date.parse('2026-07-04T10:01:01.000Z'),
  });
  assert.equal(polled.status, 'approved');
  assert.equal(polled.accountId, 'acct_bri');
  assert.match(polled.key, /^sk_/);
  assert.equal(pool.deviceGrants[0].api_key_plaintext, null, 'plaintext is cleared after one poll');

  const second = await pollDeviceGrant(pool, {
    deviceCode: issued.deviceCode,
    now: Date.parse('2026-07-04T10:01:02.000Z'),
  });
  assert.equal(second.status, 'consumed');
});

test('normalizeUserCode accepts pasted codes with spaces or hyphens', () => {
  assert.equal(normalizeUserCode(' abcd efgh '), 'ABCD-EFGH');
  assert.equal(normalizeUserCode('ABCD-EFGH'), 'ABCD-EFGH');
  assert.equal(normalizeUserCode('bad'), null);
});

test('hosted device auth routes exchange browser approval for one CLI credential', async () => {
  const previousSecret = process.env.SCOPE_JWT_SECRET;
  process.env.SCOPE_JWT_SECRET = 'scope-test-jwt-secret-9f3a7c1e2b8d4506';
  const pool = new MemoryAuthPool();
  const app = express();
  app.use(express.json());
  app.use(publicAuthRouter({ pool, appPath: '/app' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const start = await fetch(`${base}/auth/device/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Codex' }),
    });
    assert.equal(start.status, 201);
    const grant = await start.json();
    assert.ok(grant.verification_uri_complete.includes(encodeURIComponent(grant.user_code)));
    assert.ok(!('key' in grant), 'start never returns a credential');

    const pending = await fetch(`${base}/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: grant.device_code }),
    });
    assert.equal(pending.status, 428);
    assert.equal((await pending.json()).status, 'pending');

    const session = mintAccessToken({ sub: 'acct_bri', tenant_id: 'tnt_scope', role: 'owner' });
    const approve = await fetch(`${base}/auth/device/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `scope_session=${session}` },
      body: JSON.stringify({ user_code: grant.user_code }),
    });
    assert.equal(approve.status, 200);
    assert.ok(!('key' in await approve.json()), 'approval page never receives the key');

    const token = await fetch(`${base}/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: grant.device_code }),
    });
    assert.equal(token.status, 200);
    const body = await token.json();
    assert.equal(body.status, 'approved');
    assert.equal(body.account_id, 'acct_bri');
    assert.match(body.key, /^sk_/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousSecret === undefined) delete process.env.SCOPE_JWT_SECRET;
    else process.env.SCOPE_JWT_SECRET = previousSecret;
  }
});

test('CLI auth poll stores the approved key without printing it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'scope-auth-home-'));
  const app = express();
  app.use(express.json());
  app.post('/auth/device/token', (_req, res) => {
    res.json({
      status: 'approved',
      key: 'sk_testid.supersecret',
      key_id: 'testid',
      account_id: 'acct_bri',
    });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const remote = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await runCli([
      'bin/scope.js',
      '--json',
      'auth',
      'poll',
      '--remote',
      remote,
      '--device-code',
      'sdc_test',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.doesNotMatch(run.stdout, /supersecret|sk_testid/);
    assert.deepEqual(JSON.parse(run.stdout), {
      authenticated: true,
      remote,
      account_id: 'acct_bri',
      key_id: 'testid',
    });
    const creds = JSON.parse(readFileSync(join(home, '.scope-hub', 'credentials.json'), 'utf8'));
    assert.equal(creds[remote].key, 'sk_testid.supersecret');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
