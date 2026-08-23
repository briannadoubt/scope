import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  PROTOCOL_VERSION,
  ScopeCliError,
  errorEnvelope,
  normalizeError,
  readReceipt,
  revisionForEvents,
  successEnvelope,
  writeReceipt,
} from '../src/protocol.js';
import { buildCapabilities } from '../src/capabilities.js';
import { UnsupportedEventVersionError } from '../src/event-schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/scope.js');

test('machine envelopes and revisions are stable', () => {
  assert.deepEqual(successEnvelope({ id: 1 }), {
    ok: true, protocolVersion: PROTOCOL_VERSION, data: { id: 1 }, meta: {},
  });
  assert.equal(errorEnvelope(new ScopeCliError('stale', { code: 'STALE_REVISION', retryable: true })).error.retryable, true);
  const a = [{ id: 'b' }, { id: 'a' }];
  assert.equal(revisionForEvents(a), revisionForEvents([...a].reverse()));
});

test('capabilities and errors expose the event reader compatibility boundary', () => {
  const capabilities = buildCapabilities({ cliVersion: 'test' });
  assert.equal(capabilities.eventFormatVersion, 2);
  assert.deepEqual(capabilities.eventFormat, {
    writerVersion: 2,
    readerVersions: [1, 2],
    minimumReaderVersion: 2,
  });

  const normalized = normalizeError(new UnsupportedEventVersionError(3));
  assert.equal(normalized.code, 'UNSUPPORTED_EVENT_FORMAT');
  assert.equal(normalized.retryable, false);
  assert.deepEqual(normalized.details.supportedVersions, [1, 2]);
});

test('receipts are durable, replayable, and reject request-id reuse across commands', () => {
  const scopeDir = mkdtempSync(join(tmpdir(), 'scope-receipt-'));
  try {
    const envelope = successEnvelope({ id: 'SCP-1' });
    writeReceipt(scopeDir, 'req-1', 'ticket create', envelope);
    assert.deepEqual(readReceipt(scopeDir, 'req-1').envelope, envelope);
    assert.throws(
      () => writeReceipt(scopeDir, 'req-1', 'ticket delete', envelope),
      /already used/
    );
  } finally {
    rmSync(scopeDir, { recursive: true, force: true });
  }
});

test('CLI idempotency receipt replays once and stale revisions fail before mutation', () => {
  const repo = mkdtempSync(join(tmpdir(), 'scope-protocol-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'scope-protocol-home-'));
  const run = (...args) => spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: repo, env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  try {
    let result = run('init', '--key', 'MAC', '--name', 'Machine');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const initialized = JSON.parse(result.stdout);
    const initialRevision = initialized.meta.revision;

    result = run('--request-id', 'create-1', 'ticket', 'create', 'Exactly once');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const first = JSON.parse(result.stdout);
    assert.equal(first.meta.replayed, false);

    result = run('--request-id', 'create-1', 'ticket', 'create', 'Exactly once');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const replay = JSON.parse(result.stdout);
    assert.equal(replay.meta.replayed, true);
    assert.equal(replay.data.id, first.data.id);

    // Simulate the narrow crash window after the authoritative event landed
    // but before the convenience response receipt survived. The event-carried
    // request id prevents a duplicate mutation and reports the applied ids.
    rmSync(join(initialized.data.storage.dataDir, 'receipts'), { recursive: true, force: true });
    result = run('--request-id', 'create-1', 'ticket', 'create', 'Exactly once');
    assert.equal(result.status, 1);
    const interrupted = JSON.parse(result.stdout);
    assert.equal(interrupted.error.code, 'REQUEST_ALREADY_APPLIED');
    assert.ok(interrupted.error.details.eventIds.length >= 1);

    result = run('--if-revision', initialRevision, 'ticket', 'create', 'Must not land');
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'STALE_REVISION');

    result = run('ticket', 'list');
    assert.equal(JSON.parse(result.stdout).data.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('doctor reports a newer event format as an upgrade requirement, not corruption', () => {
  const repo = mkdtempSync(join(tmpdir(), 'scope-compat-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'scope-compat-home-'));
  const run = (...args) => spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: repo, env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  try {
    const initializedResult = run('init', '--key', 'CMP', '--name', 'Compatibility');
    assert.equal(initializedResult.status, 0, initializedResult.stderr || initializedResult.stdout);
    const initialized = JSON.parse(initializedResult.stdout);
    const dir = join(initialized.data.storage.dataDir, 'events');
    const future = makeFutureEvent(3);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${future.id}.json`), JSON.stringify(future));

    const doctorResult = run('doctor');
    assert.equal(doctorResult.status, 2, doctorResult.stderr || doctorResult.stdout);
    const doctor = JSON.parse(doctorResult.stdout);
    assert.equal(doctor.data.eventStore.corruptFiles.length, 0);
    assert.equal(doctor.data.eventStore.incompatibleFiles.length, 1);
    assert.match(doctor.data.cache.error, /requires a newer Scope reader/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

function makeFutureEvent(version) {
  const event = {
    v: 2,
    id: '01JZ9F2K7QABCD3EFGH4JKMN5',
    ts: '2026-08-23T00:00:00.000Z',
    hlc: '1787443200000-000000',
    actor: 'future',
    kind: 'ticket.delete',
    payload: { ticketId: 'SCP-1' },
  };
  event.v = version;
  return event;
}
