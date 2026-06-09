import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readRemoteConfig,
  writeRemoteConfig,
  resolveRemote,
  remoteConfigPath,
} from '../src/remote-config.js';

/**
 * SCP-193 — `.scope/remote.json`: the committed, team-shared pointer at a
 * hosted hub (which URL, which project board). Covers read/write round-trips,
 * the no-secrets shape, and resolveRemote precedence (flags > env > file >
 * null) — the exact resolution `scope sync` and `scope projects` run.
 */

const tempScopeDir = () => mkdtempSync(join(tmpdir(), 'scope-remote-'));

/** Run fn with SCOPE_REMOTE/SCOPE_PROJECT pinned (undefined = unset), then restore. */
function withEnv(vars, fn) {
  const saved = {};
  for (const k of ['SCOPE_REMOTE', 'SCOPE_PROJECT']) {
    saved[k] = process.env[k];
    if (k in vars && vars[k] !== undefined) process.env[k] = vars[k];
    else delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('readRemoteConfig: missing file (or no scopeDir) is null, not an error', () => {
  assert.equal(readRemoteConfig(tempScopeDir()), null);
  assert.equal(readRemoteConfig(null), null);
  assert.equal(readRemoteConfig(undefined), null);
});

test('write/read round-trip — pretty-printed, committed-friendly shape', () => {
  const dir = tempScopeDir();
  const written = writeRemoteConfig(dir, { url: 'https://scope-hub.fly.dev', project: 'tnt_abc123' });
  assert.deepEqual(written, { url: 'https://scope-hub.fly.dev', project: 'tnt_abc123' });
  assert.deepEqual(readRemoteConfig(dir), written);

  // Pretty-printed (2-space indent) + trailing newline — it lives in git diffs.
  const raw = readFileSync(remoteConfigPath(dir), 'utf8');
  assert.equal(raw, '{\n  "url": "https://scope-hub.fly.dev",\n  "project": "tnt_abc123"\n}\n');
});

test('writeRemoteConfig never persists secrets — only url and project survive', () => {
  const dir = tempScopeDir();
  writeRemoteConfig(dir, {
    url: 'https://hub.example',
    project: 'tnt_x',
    token: 'sk_super_secret', // must be dropped: the file is committed
    apiKey: 'sk_other_secret',
  });
  const raw = readFileSync(remoteConfigPath(dir), 'utf8');
  assert.ok(!raw.includes('sk_super_secret'), 'token not written');
  assert.ok(!raw.includes('sk_other_secret'), 'apiKey not written');
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['project', 'url']);
});

test('writeRemoteConfig omits absent fields (url-only and project-only configs)', () => {
  const dir = tempScopeDir();
  writeRemoteConfig(dir, { url: 'https://hub.example' });
  assert.deepEqual(readRemoteConfig(dir), { url: 'https://hub.example' });
  writeRemoteConfig(dir, { project: 'tnt_only' });
  assert.deepEqual(readRemoteConfig(dir), { project: 'tnt_only' });
});

test('readRemoteConfig: malformed json throws with the file path', () => {
  const dir = tempScopeDir();
  writeFileSync(remoteConfigPath(dir), '{not json');
  assert.throws(() => readRemoteConfig(dir), new RegExp(remoteConfigPath(dir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('resolveRemote: nothing configured resolves to null/none everywhere', () => {
  withEnv({}, () => {
    const r = resolveRemote(tempScopeDir());
    assert.deepEqual(r, { url: null, project: null, source: { url: 'none', project: 'none' } });
    // No scopeDir at all (e.g. `scope projects list --remote …` outside a repo).
    const r2 = resolveRemote(null, { remote: 'https://flag.example' });
    assert.equal(r2.url, 'https://flag.example');
    assert.equal(r2.source.url, 'flag');
    assert.equal(r2.project, null);
  });
});

test('resolveRemote: file layer fills in what flags/env do not', () => {
  const dir = tempScopeDir();
  writeRemoteConfig(dir, { url: 'https://file.example', project: 'tnt_file' });
  withEnv({}, () => {
    const r = resolveRemote(dir);
    assert.deepEqual(r, {
      url: 'https://file.example',
      project: 'tnt_file',
      source: { url: 'file', project: 'file' },
    });
  });
});

test('resolveRemote precedence: flags > env > file, independently per field', () => {
  const dir = tempScopeDir();
  writeRemoteConfig(dir, { url: 'https://file.example', project: 'tnt_file' });
  withEnv({ SCOPE_REMOTE: 'https://env.example', SCOPE_PROJECT: 'tnt_env' }, () => {
    // env beats file
    let r = resolveRemote(dir);
    assert.deepEqual(r, {
      url: 'https://env.example',
      project: 'tnt_env',
      source: { url: 'env', project: 'env' },
    });
    // flags beat env
    r = resolveRemote(dir, { remote: 'https://flag.example', project: 'tnt_flag' });
    assert.deepEqual(r, {
      url: 'https://flag.example',
      project: 'tnt_flag',
      source: { url: 'flag', project: 'flag' },
    });
    // mixed: flag url + env project — each field resolves on its own
    r = resolveRemote(dir, { remote: 'https://flag.example' });
    assert.equal(r.url, 'https://flag.example');
    assert.equal(r.source.url, 'flag');
    assert.equal(r.project, 'tnt_env');
    assert.equal(r.source.project, 'env');
  });
});

test('scope sync resolution: --remote-workspace wins over --project (legacy selector first)', () => {
  // The sync command passes `opts.remoteWorkspace || opts.project` as the
  // project flag — model that exact expression here so the contract is pinned.
  const dir = tempScopeDir();
  writeRemoteConfig(dir, { url: 'https://file.example', project: 'tnt_file' });
  withEnv({}, () => {
    const opts = { remoteWorkspace: 'ws_legacy', project: 'tnt_new' };
    const r = resolveRemote(dir, { remote: undefined, project: opts.remoteWorkspace || opts.project });
    assert.equal(r.project, 'ws_legacy', '--remote-workspace beats --project');
    assert.equal(r.url, 'https://file.example', 'url still falls back to the committed file');
    // Without the legacy flag, --project flows through.
    const r2 = resolveRemote(dir, { project: undefined || opts.project });
    assert.equal(r2.project, 'tnt_new');
  });
});
