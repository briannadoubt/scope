import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTempScope } from './helpers.js';
import { getMessage, registerAgent, sendMessage } from '../src/agent-mailbox.js';
import { openWorkspaceDb } from '../src/workspace-open.js';
import {
  SessionBridgeRunner,
  bindSession,
  bridgePaths,
  bridgePrompt,
  injectSessionMessage,
  listSessionBindings,
  readBridgeState,
  sessionBridgeOverview,
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
  const result = await injectSessionMessage(binding, message, { spawnImpl, env: {} });
  assert.equal(result.ok, true);
  assert.equal(call.command, 'codex');
  assert.deepEqual(call.args, ['exec', 'resume', '--json', CODEX_SESSION, '-']);
  assert.match(call.stdin, /01MESSAGE/);
  assert.equal(call.stdin.includes(message.body), false);
  assert.equal(bridgePrompt(binding, message).includes(message.body), false);
  assert.equal(call.options.shell, false);
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
    await second.stop();
    const replacement = new SessionBridgeRunner({ env: home.env, pollMs: 60_000 }).start();
    assert.equal(replacement.ownsLock, true);
    await replacement.stop();
  } finally {
    home.cleanup();
  }
});
