import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installLifecycleHooks, lifecycleHookPath, lifecycleHookStatus } from '../src/lifecycle-hooks.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/scope.js');

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'scope-hooks-home-'));
  return { home, env: { HOME: home }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('lifecycle hook installer preserves unrelated Codex and Claude configuration and is idempotent', () => {
  const temp = tempHome();
  try {
    const codexPath = lifecycleHookPath('codex', temp.env);
    const claudePath = lifecycleHookPath('claude', temp.env);
    mkdirSync(dirname(codexPath), { recursive: true });
    mkdirSync(dirname(claudePath), { recursive: true });
    writeFileSync(codexPath, JSON.stringify({
      description: 'personal hooks',
      hooks: {
        SessionStart: [{ matcher: 'compact', hooks: [{ type: 'command', command: 'remember-context' }] }],
      },
    }));
    writeFileSync(claudePath, JSON.stringify({
      model: 'opus',
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: 'save-notes' }] }],
      },
    }));

    for (const provider of ['codex', 'claude']) {
      installLifecycleHooks(provider, { env: temp.env });
      installLifecycleHooks(provider, { env: temp.env });
      assert.equal(lifecycleHookStatus(provider, { env: temp.env }).installed, true);
    }

    const codex = JSON.parse(readFileSync(codexPath, 'utf8'));
    const claude = JSON.parse(readFileSync(claudePath, 'utf8'));
    assert.equal(codex.description, 'personal hooks');
    assert.equal(claude.model, 'opus');
    assert.equal(JSON.stringify(codex).includes('remember-context'), true);
    assert.equal(JSON.stringify(claude).includes('save-notes'), true);
    assert.equal((JSON.stringify(codex).match(/scope bridge lifecycle --provider codex/g) || []).length, 2);
    assert.equal((JSON.stringify(claude).match(/scope bridge lifecycle --provider claude/g) || []).length, 2);
    assert.match(codex.hooks.SessionStart.at(-1).matcher, /compact/);
    assert.match(claude.hooks.SessionStart.at(-1).matcher, /fork/);
  } finally {
    temp.cleanup();
  }
});

test('lifecycle CLI registers, reuses, and ends a private session identity', () => {
  const temp = tempHome();
  const repo = mkdtempSync(join(tmpdir(), 'scope-lifecycle-cli-repo-'));
  const run = (args, input) => spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: repo,
    env: { ...process.env, HOME: temp.home },
    encoding: 'utf8',
    input,
  });
  try {
    let result = run(['init', '--key', 'LIF', '--name', 'Lifecycle CLI']);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    // Prevent this hermetic CLI test from starting a detached bridge process.
    const bridgeDir = join(temp.home, '.scope');
    mkdirSync(bridgeDir, { recursive: true });
    writeFileSync(join(bridgeDir, 'bridge-state.json'), JSON.stringify({
      version: 1,
      runner: { pid: process.pid, heartbeatAt: new Date().toISOString() },
      deliveries: {},
    }));

    const sessionId = 'private_cli_session';
    const payload = (hookEventName, source) => JSON.stringify({
      session_id: sessionId,
      cwd: repo,
      hook_event_name: hookEventName,
      ...(source ? { source } : {}),
    });
    result = run(['bridge', 'lifecycle', '--provider', 'codex'], payload('SessionStart', 'startup'));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const started = JSON.parse(result.stdout).data;
    assert.match(started.agentId, /^codex:session:[0-9a-f]{24}$/);
    assert.equal(started.reused, false);
    assert.equal(started.runnerStarted, false);
    assert.equal(JSON.stringify(started).includes(sessionId), false);

    result = run(['bridge', 'lifecycle', '--provider', 'codex'], payload('SessionStart', 'compact'));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const resumed = JSON.parse(result.stdout).data;
    assert.equal(resumed.agentId, started.agentId);
    assert.equal(resumed.reused, true);

    result = run(['bridge', 'lifecycle', '--provider', 'codex'], payload('SessionEnd'));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const ended = JSON.parse(result.stdout).data;
    assert.equal(ended.agentId, started.agentId);
    assert.equal(ended.handled, true);
    assert.equal(ended.unbound, true);
  } finally {
    temp.cleanup();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('automatically managed bridge runner exits cleanly when no bindings remain', () => {
  const temp = tempHome();
  try {
    const result = spawnSync(process.execPath, [CLI, '--json', 'bridge', 'run', '--exit-when-idle'], {
      cwd: ROOT,
      env: { ...process.env, HOME: temp.home },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).data.running, true);
    const state = JSON.parse(readFileSync(join(temp.home, '.scope', 'bridge-state.json'), 'utf8'));
    assert.equal(state.runner, null);
  } finally {
    temp.cleanup();
  }
});

test('lifecycle hook installer refuses to overwrite malformed user configuration', () => {
  const temp = tempHome();
  try {
    const path = lifecycleHookPath('claude', temp.env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');
    assert.throws(() => installLifecycleHooks('claude', { env: temp.env }), /invalid JSON/);
    assert.equal(readFileSync(path, 'utf8'), '{ not json');
  } finally {
    temp.cleanup();
  }
});
