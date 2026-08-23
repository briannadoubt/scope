import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  disableDogfoodTelemetry,
  dogfoodConfigPath,
  dogfoodStatus,
  dogfoodWorkspaceHash,
  enableDogfoodTelemetry,
  recordDogfoodTelemetry,
  startDogfoodSpan,
} from '../src/dogfood-telemetry.js';
import { apiFetch, startTestServer } from './helpers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/scope.js');

test('dogfood telemetry is default-on, bounded, private, and failure-isolated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-dogfood-'));
  const log = join(dir, 'nested', 'usage.ndjson');
  try {
    const wrote = recordDogfoodTelemetry({
      surface: 'cli',
      operation: 'ticket create',
      outcome: 'success',
      durationMs: 12.6,
      workspace: '/private/project/customer-name',
      json: true,
      requestId: false,
      body: 'SECRET MESSAGE BODY',
      args: ['SECRET TITLE'],
      token: 'sk-secret',
    }, {
      env: { SCOPE_DOGFOOD_LOG: log },
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    assert.equal(wrote, true);
    const raw = readFileSync(log, 'utf8');
    assert.doesNotMatch(raw, /SECRET|customer-name|sk-secret/);
    assert.equal(statSync(log).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(raw), {
      schemaVersion: 1,
      timestamp: '2026-08-23T00:00:00.000Z',
      surface: 'cli',
      operation: 'ticket create',
      outcome: 'success',
      durationMs: 13,
      workspaceHash: dogfoodWorkspaceHash('/private/project/customer-name'),
      json: true,
      requestId: false,
    });
    assert.equal(recordDogfoodTelemetry(
      { surface: 'cli', operation: 'unsafe\noperation' },
      { env: { SCOPE_DOGFOOD_LOG: log } }
    ), false);
    assert.equal(recordDogfoodTelemetry(
      { surface: 'cli', operation: 'ticket list' },
      { env: { SCOPE_DOGFOOD_LOG: '/dev/null/not-a-file' } }
    ), false, 'telemetry errors never affect Scope');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('machine-wide dogfood status defaults on and can be configured or disabled', () => {
  const home = mkdtempSync(join(tmpdir(), 'scope-dogfood-config-'));
  const env = { HOME: home };
  const customLog = join(home, 'custom', 'usage.ndjson');
  try {
    assert.deepEqual(dogfoodStatus(env), {
      enabled: true,
      source: 'default',
      logPath: join(home, '.scope', 'dogfood', 'usage.ndjson'),
    });
    assert.equal(recordDogfoodTelemetry(
      { surface: 'cli', operation: 'ticket list' },
      { env }
    ), true);

    const enabled = enableDogfoodTelemetry(customLog, {
      env,
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    assert.deepEqual(enabled, { enabled: true, source: 'config', logPath: customLog });
    assert.equal(statSync(dogfoodConfigPath(env)).mode & 0o777, 0o600);

    const disabled = disableDogfoodTelemetry({
      env,
      now: () => new Date('2026-08-23T00:01:00.000Z'),
    });
    assert.deepEqual(disabled, { enabled: false, source: 'config', logPath: customLog });
    assert.equal(recordDogfoodTelemetry(
      { surface: 'cli', operation: 'ticket list' },
      { env }
    ), false);

    assert.deepEqual(dogfoodStatus({ ...env, SCOPE_DOGFOOD_LOG: customLog }), {
      enabled: true,
      source: 'environment',
      logPath: customLog,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('dogfood spans finish once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-dogfood-span-'));
  const log = join(dir, 'usage.ndjson');
  try {
    const span = startDogfoodSpan(
      { surface: 'http', operation: 'GET /api/meta' },
      { env: { SCOPE_DOGFOOD_LOG: log } }
    );
    assert.equal(span.finish({ statusCode: 200 }), true);
    assert.equal(span.finish({ statusCode: 500, outcome: 'error' }), false);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI dogfood records command paths and outcomes without arguments or content', () => {
  const repo = mkdtempSync(join(tmpdir(), 'scope-dogfood-cli-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'scope-dogfood-cli-home-'));
  const log = join(home, '.scope', 'dogfood', 'usage.ndjson');
  const secret = 'TOP-SECRET-CUSTOMER-TITLE';
  const run = (...args) => spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home, SCOPE_DOGFOOD_LOG: log },
    encoding: 'utf8',
  });
  try {
    let result = run('init', '--key', 'DOG', '--name', secret);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = run('ticket', 'create', secret);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = run('ticket', 'show', 'DOG-999999');
    assert.equal(result.status, 1);

    const raw = readFileSync(log, 'utf8');
    assert.doesNotMatch(raw, new RegExp(secret));
    assert.doesNotMatch(raw, /DOG-999999/);
    const records = raw.trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map((item) => item.operation), ['init', 'ticket create', 'ticket show']);
    assert.deepEqual(records.map((item) => item.outcome), ['success', 'success', 'error']);
    assert.equal(records.at(-1).errorCode, 'NOT_FOUND');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hub dogfood records route templates without ids, queries, or bodies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-dogfood-http-'));
  const log = join(dir, 'usage.ndjson');
  const previous = process.env.SCOPE_DOGFOOD_LOG;
  process.env.SCOPE_DOGFOOD_LOG = log;
  let server;
  try {
    server = await startTestServer();
    const secretId = 'SENSITIVE-CUSTOMER-ID';
    const response = await apiFetch(server.baseUrl, `/api/tickets/${secretId}?token=SECRET-TOKEN`);
    assert.equal(response.status, 404);
    const raw = readFileSync(log, 'utf8');
    assert.doesNotMatch(raw, /SENSITIVE|SECRET-TOKEN/);
    const record = raw.trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(record.surface, 'http');
    assert.equal(record.operation, 'GET /api/tickets/:id');
    assert.equal(record.outcome, 'error');
    assert.equal(record.statusCode, 404);
  } finally {
    if (server) await server.close();
    if (previous === undefined) delete process.env.SCOPE_DOGFOOD_LOG;
    else process.env.SCOPE_DOGFOOD_LOG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
