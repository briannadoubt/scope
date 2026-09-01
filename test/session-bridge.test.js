import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTempScope } from './helpers.js';
import { ensureEventLog } from '../src/backfill.js';
import { eventsDir, readAllEvents } from '../src/event-store.js';
import { acknowledgeMessage, getAgent, getMessage, registerAgent, sendMessage } from '../src/agent-mailbox.js';
import { claimTicket } from '../src/agent-runtime.js';
import { createTicket } from '../src/repo.js';
import { openWorkspaceDb } from '../src/workspace-open.js';
import {
  SessionBridgeRunner,
  automaticAgentId,
  bindSession,
  bridgePaths,
  bridgePrompt,
  endSessionLifecycle,
  findSessionBinding,
  injectSessionMessage,
  listSessionBindings,
  providerExecutable,
  readBridgeState,
  sessionBridgeOverview,
  sessionBridgeRunnerActive,
  startSessionLifecycle,
} from '../src/session-bridge.js';

const CODEX_SESSION = '11111111-1111-4111-8111-111111111111';
const CLAUDE_SESSION = '22222222-2222-4222-8222-222222222222';

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'scope-bridge-home-'));
  return { env: { HOME: home }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('session bindings are private, workspace-local, and never reveal a session id', () => {
  const home = tempHome();
  const one = createTempScope();
  const two = createTempScope();
  try {
    const result = bindSession({
      scopeDir: one.scopeDir,
      agentId: 'codex:sol',
      provider: 'openai',
      sessionId: CODEX_SESSION,
      env: home.env,
    });
    assert.equal(result.provider, 'codex');
    assert.match(result.sessionRef, /^sha256:/);
    assert.equal(JSON.stringify(result).includes(CODEX_SESSION), false);
    assert.equal(listSessionBindings({ scopeDir: one.scopeDir, env: home.env }).length, 1);
    assert.equal(listSessionBindings({ scopeDir: two.scopeDir, env: home.env }).length, 0);
    assert.equal(statSync(bridgePaths(home.env).config).mode & 0o777, 0o600);
  } finally {
    one.cleanup();
    two.cleanup();
    home.cleanup();
  }
});

test('automatic lifecycle identity is random, stable on resume, renewable, and private in shared events', async () => {
  const home = tempHome();
  const scope = createTempScope();
  let now = new Date('2026-08-28T10:00:00.000Z');
  try {
    ensureEventLog(scope.db, scope.scopeDir);
    const sessionId = 'thr_private_codex_session';
    const started = startSessionLifecycle({
      db: scope.db,
      scopeDir: scope.scopeDir,
      provider: 'codex',
      sessionId,
      cwd: '/tmp/example',
      env: home.env,
      now: () => now,
      random: (size) => Buffer.alloc(size, 0xab),
    });
    assert.equal(started.agentId, `codex:session:${'ab'.repeat(12)}`);
    assert.equal(started.reused, false);
    assert.equal(getAgent(scope.db, started.agentId, { now }).status, 'online');
    assert.equal(findSessionBinding({ provider: 'codex', sessionId, env: home.env }).agentId, started.agentId);
    assert.equal(JSON.stringify(readAllEvents(eventsDir(scope.scopeDir))).includes(sessionId), false);

    now = new Date(now.getTime() + 61_000);
    const runner = new SessionBridgeRunner({
      env: home.env,
      now: () => now,
      openWorkspace: () => ({ db: scope.db }),
      inject: async () => ({ ok: true, provider: 'codex' }),
    });
    await runner.tick();
    assert.equal(getAgent(scope.db, started.agentId, { now }).lastSeenAt, now.toISOString());

    const resumed = startSessionLifecycle({
      db: scope.db,
      scopeDir: scope.scopeDir,
      provider: 'codex',
      sessionId,
      cwd: '/tmp/example',
      env: home.env,
      now: () => now,
    });
    assert.equal(resumed.agentId, started.agentId);
    assert.equal(resumed.reused, true);
    assert.equal(listSessionBindings({ scopeDir: scope.scopeDir, env: home.env }).length, 1);
    assert.equal(automaticAgentId('claude', (size) => Buffer.alloc(size, 0xcd)), `claude:session:${'cd'.repeat(12)}`);
    runner.dbs.clear();
  } finally {
    scope.cleanup();
    home.cleanup();
  }
});

test('session end marks the automatic agent offline, releases work, and unbinds privately', () => {
  const home = tempHome();
  const scope = createTempScope();
  const now = new Date('2026-08-28T11:00:00.000Z');
  try {
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const started = startSessionLifecycle({
      db: scope.db,
      scopeDir: scope.scopeDir,
      provider: 'claude',
      sessionId,
      cwd: '/tmp/example',
      env: home.env,
      now: () => now,
      random: (size) => Buffer.alloc(size, 0xef),
    });
    const ticket = createTicket(scope.db, {
      type: 'story', title: 'Lifecycle-owned work', status: 'todo', actor: 'planner', now,
    });
    const claim = claimTicket(scope.db, ticket.id, { agent: started.agentId, now });
    const ended = endSessionLifecycle({
      db: scope.db,
      scopeDir: scope.scopeDir,
      provider: 'claude',
      sessionId,
      env: home.env,
      now: () => new Date(now.getTime() + 1_000),
    });
    assert.equal(ended.handled, true);
    assert.deepEqual(ended.releasedLeaseIds, [claim.lease.leaseId]);
    assert.equal(getAgent(scope.db, started.agentId).status, 'offline');
    assert.equal(listSessionBindings({ scopeDir: scope.scopeDir, env: home.env }).length, 0);

    const resumed = startSessionLifecycle({
      db: scope.db,
      scopeDir: scope.scopeDir,
      provider: 'claude',
      sessionId,
      cwd: '/tmp/example',
      env: home.env,
      now: () => new Date(now.getTime() + 2_000),
    });
    assert.equal(resumed.agentId, started.agentId, 'resume reuses the private identity after end unbound it');
    assert.equal(resumed.reused, true);
    assert.equal(getAgent(scope.db, started.agentId, { now: new Date(now.getTime() + 2_000) }).status, 'online');
  } finally {
    scope.cleanup();
    home.cleanup();
  }
});

test('provider injection uses argv and stdin without copying durable message bodies into the wakeup', async () => {
  let call;
  const spawnImpl = (command, args, options) => {
    call = { command, args, options, stdin: '' };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (chunk) => { call.stdin += chunk.toString(); });
    child.stdin.on('finish', () => process.nextTick(() => child.emit('close', 0, null)));
    child.kill = () => {};
    return child;
  };
  const binding = {
    scopeDir: '/tmp/example/.scope', agentId: 'codex:sol', provider: 'codex',
    sessionId: CODEX_SESSION, cwd: '/tmp/example',
  };
  const message = { messageId: '01MESSAGE', body: 'private durable body' };
  const result = await injectSessionMessage(binding, message, {
    spawnImpl,
    env: { HOME: '/missing', PATH: '/missing' },
  });
  assert.equal(result.ok, true);
  assert.equal(call.command, 'codex');
  assert.deepEqual(call.args, ['exec', 'resume', '--json', CODEX_SESSION, '-']);
  assert.match(call.stdin, /01MESSAGE/);
  assert.equal(call.stdin.includes(message.body), false);
  assert.equal(bridgePrompt(binding, message).includes(message.body), false);
  assert.equal(call.options.shell, false);
});

test('provider executable resolution supports daemon-safe user-local installs and explicit overrides', () => {
  const home = tempHome();
  try {
    const localBin = join(home.env.HOME, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    writeFileSync(join(localBin, 'claude'), '');
    assert.equal(providerExecutable('claude', { ...home.env, PATH: '/usr/bin' }), join(localBin, 'claude'));
    assert.equal(providerExecutable('codex', { ...home.env, SCOPE_CODEX_BIN: '/custom/codex' }), '/custom/codex');
  } finally {
    home.cleanup();
  }
});

test('runner injects one pending message, checkpoints acceptance, and acknowledges it', async () => {
  const home = tempHome();
  const scope = createTempScope();
  try {
    registerAgent(scope.db, 'codex:sol', { provider: 'openai' });
    registerAgent(scope.db, 'claude:opus', { provider: 'anthropic' });
    const message = sendMessage(scope.db, {
      fromAgent: 'claude:opus', toAgent: 'codex:sol', body: 'Please inspect the fix.',
    });
    bindSession({
      scopeDir: scope.scopeDir,
      agentId: 'codex:sol',
      provider: 'codex',
      sessionId: CODEX_SESSION,
      env: home.env,
    });
    let injections = 0;
    const runner = new SessionBridgeRunner({
      env: home.env,
      openWorkspace: () => ({ db: scope.db }),
      inject: async () => { injections += 1; return { ok: true, provider: 'codex' }; },
    });
    await runner.tick();
    assert.equal(injections, 1);
    assert.equal(getMessage(scope.db, message.messageId).deliveryStatus, 'acknowledged');
    const serialized = readFileSync(bridgePaths(home.env).state, 'utf8');
    assert.equal(serialized.includes(message.body), false);
    assert.equal(Object.values(readBridgeState({ env: home.env }).deliveries)[0].status, 'acknowledged');
    assert.equal(sessionBridgeOverview(scope.scopeDir, { env: home.env })['codex:sol'].connected, true);
    runner.dbs.clear();
  } finally {
    scope.cleanup();
    home.cleanup();
  }
});

test('failed provider delivery remains pending and exposes only a safe retry code', async () => {
  const home = tempHome();
  const scope = createTempScope();
  try {
    registerAgent(scope.db, 'codex:sol', { provider: 'openai' });
    registerAgent(scope.db, 'claude:opus', { provider: 'anthropic' });
    const message = sendMessage(scope.db, {
      fromAgent: 'codex:sol', toAgent: 'claude:opus', body: 'Wake up later.',
    });
    bindSession({
      scopeDir: scope.scopeDir,
      agentId: 'claude:opus',
      provider: 'claude',
      sessionId: CLAUDE_SESSION,
      env: home.env,
    });
    const runner = new SessionBridgeRunner({
      env: home.env,
      openWorkspace: () => ({ db: scope.db }),
      inject: async () => ({ ok: false, provider: 'claude', errorCode: 'BRIDGE_SESSION_BUSY' }),
    });
    await runner.tick();
    assert.equal(getMessage(scope.db, message.messageId).deliveryStatus, 'pending');
    const delivery = Object.values(readBridgeState({ env: home.env }).deliveries)[0];
    assert.equal(delivery.status, 'retrying');
    assert.equal(delivery.errorCode, 'BRIDGE_SESSION_BUSY');
    assert.equal(JSON.stringify(delivery).includes(message.body), false);
    runner.dbs.clear();
  } finally {
    scope.cleanup();
    home.cleanup();
  }
});

test('a later acknowledged delivery clears stale retry status without deleting failure evidence', async () => {
  const home = tempHome();
  const scope = createTempScope();
  let now = new Date('2026-08-28T12:00:00.000Z');
  try {
    registerAgent(scope.db, 'codex:sol', { provider: 'openai' });
    registerAgent(scope.db, 'claude:opus', { provider: 'anthropic' });
    const failed = sendMessage(scope.db, {
      fromAgent: 'claude:opus', toAgent: 'codex:sol', body: 'First delivery fails.', now,
    });
    bindSession({
      scopeDir: scope.scopeDir,
      agentId: 'codex:sol',
      provider: 'codex',
      sessionId: CODEX_SESSION,
      env: home.env,
    });
    const results = [
      { ok: false, provider: 'codex', errorCode: 'BRIDGE_SESSION_BUSY' },
      { ok: true, provider: 'codex', durationMs: 5 },
    ];
    const runner = new SessionBridgeRunner({
      env: home.env,
      now: () => now,
      openWorkspace: () => ({ db: scope.db }),
      inject: async () => results.shift(),
    });

    await runner.tick();
    let overview = sessionBridgeOverview(scope.scopeDir, { env: home.env, now: () => now });
    assert.equal(overview['codex:sol'].retrying, true);
    assert.equal(overview['codex:sol'].lastErrorCode, 'BRIDGE_SESSION_BUSY');

    // Preserve the failed private delivery record but resolve the durable
    // mailbox item out of band, as an operator or provider callback may do.
    acknowledgeMessage(scope.db, failed.messageId, { agent: 'codex:sol', actor: 'operator', now });
    now = new Date(now.getTime() + 1_000);
    const succeeded = sendMessage(scope.db, {
      fromAgent: 'claude:opus', toAgent: 'codex:sol', body: 'Second delivery succeeds.', now,
    });
    await runner.tick();

    overview = sessionBridgeOverview(scope.scopeDir, { env: home.env, now: () => now });
    assert.equal(getMessage(scope.db, succeeded.messageId).deliveryStatus, 'acknowledged');
    assert.equal(overview['codex:sol'].retrying, false);
    assert.equal(overview['codex:sol'].lastErrorCode, null);
    const deliveries = Object.values(readBridgeState({ env: home.env }).deliveries);
    assert.equal(deliveries.some((item) => item.messageId === failed.messageId && item.status === 'retrying'), true);
    runner.dbs.clear();
  } finally {
    scope.cleanup();
    home.cleanup();
  }
});

test('accepted checkpoint prevents reinjection when acknowledgement is interrupted', async () => {
  const home = tempHome();
  const scope = createTempScope();
  let reopened;
  try {
    registerAgent(scope.db, 'codex:sol', { provider: 'openai' });
    registerAgent(scope.db, 'claude:opus', { provider: 'anthropic' });
    const message = sendMessage(scope.db, {
      fromAgent: 'claude:opus', toAgent: 'codex:sol', body: 'Only deliver this once.',
    });
    bindSession({
      scopeDir: scope.scopeDir,
      agentId: 'codex:sol',
      provider: 'codex',
      sessionId: CODEX_SESSION,
      env: home.env,
    });
    let injections = 0;
    const interrupted = new SessionBridgeRunner({
      env: home.env,
      openWorkspace: () => ({ db: scope.db }),
      inject: async () => {
        injections += 1;
        scope.db.close();
        return { ok: true, provider: 'codex', durationMs: 5 };
      },
    });
    await interrupted.tick();
    assert.equal(Object.values(readBridgeState({ env: home.env }).deliveries)[0].status, 'accepted');

    reopened = openWorkspaceDb(scope.scopeDir).db;
    const recovered = new SessionBridgeRunner({
      env: home.env,
      openWorkspace: () => ({ db: reopened }),
      inject: async () => { injections += 1; return { ok: true, provider: 'codex' }; },
    });
    await recovered.tick();
    assert.equal(injections, 1, 'recovery acknowledges the accepted turn without resuming it again');
    assert.equal(getMessage(reopened, message.messageId).deliveryStatus, 'acknowledged');
    interrupted.dbs.clear();
    recovered.dbs.clear();
  } finally {
    try { reopened?.close(); } catch {}
    scope.cleanup();
    home.cleanup();
  }
});

test('only one runner owns a machine-local bridge lock', async () => {
  const home = tempHome();
  try {
    const first = new SessionBridgeRunner({ env: home.env, pollMs: 60_000 }).start();
    const second = new SessionBridgeRunner({ env: home.env, pollMs: 60_000 }).start();
    assert.equal(first.ownsLock, true);
    assert.equal(second.ownsLock, false);
    await first.stop();
    assert.equal(sessionBridgeRunnerActive({ env: home.env }), false);
    await second.stop();
    const replacement = new SessionBridgeRunner({ env: home.env, pollMs: 60_000 }).start();
    assert.equal(replacement.ownsLock, true);
    await replacement.stop();
  } finally {
    home.cleanup();
  }
});
