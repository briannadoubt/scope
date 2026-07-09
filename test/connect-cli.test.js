import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/scope.js');

function writeTestCredential(home, url, key) {
  const dir = join(home, '.scope-hub');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ [url]: { key } }, null, 2) + '\n');
}

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out: ${stderr || stdout}`));
    }, 8000);
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

async function fakeHub() {
  const calls = { auth: [], pushed: 0, pulled: 0 };
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => {
    calls.auth.push(req.get('authorization') || '');
    next();
  });
  app.get('/api/projects', (_req, res) => {
    res.json([{ tenant_id: 'tnt_existing', name: 'Existing', role: 'owner' }]);
  });
  app.post('/api/projects', (req, res) => {
    res.status(201).json({ tenantId: 'tnt_created', key: 'CRE', name: req.body?.name || 'Created' });
  });
  app.post('/api/sync/push', (req, res) => {
    calls.pushed += Array.isArray(req.body?.events) ? req.body.events.length : 0;
    res.json({ accepted: (req.body?.events || []).map((event) => event.id), duplicates: [], renumbered: [] });
  });
  app.get('/api/sync/pull', (_req, res) => {
    calls.pulled += 1;
    res.json({ events: [], cursor: 'cur_fake' });
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    calls,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('scope connect creates a remote project, writes a safe pointer, and runs initial sync', async () => {
  const home = mkdtempSync(join(tmpdir(), 'scope-connect-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'scope-connect-repo-'));
  const hub = await fakeHub();
  try {
    let run = await runCli([
      CLI,
      '--json',
      'init',
      '--key',
      'CON',
      '--name',
      'Connect Test',
    ], {
      cwd: repo,
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    writeTestCredential(home, hub.base, 'sk_fake.secret');
    run = await runCli([
      CLI,
      '--json',
      'connect',
      '--remote',
      hub.base,
      '--new',
      'Connect Test',
    ], {
      cwd: repo,
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.doesNotMatch(run.stdout, /sk_fake|secret/);
    const out = JSON.parse(run.stdout);
    assert.equal(out.remote.url, hub.base);
    assert.equal(out.remote.project, 'tnt_created');
    assert.equal(out.synced.pulled, 0);
    assert.ok(hub.calls.pushed > 0, 'initial sync pushed local events');
    assert.equal(hub.calls.pulled, 1, 'initial sync pulled once');
    assert.ok(hub.calls.auth.some((header) => header === 'Bearer sk_fake.secret'));

    const remoteCfg = JSON.parse(readFileSync(join(repo, '.scope', 'remote.json'), 'utf8'));
    assert.deepEqual(remoteCfg, { url: hub.base, project: 'tnt_created' });
    assert.doesNotMatch(readFileSync(join(repo, '.scope', 'remote.json'), 'utf8'), /sk_fake|secret/);
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('scope connect can join an existing project without creating one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'scope-connect-home-'));
  const repo = mkdtempSync(join(tmpdir(), 'scope-connect-repo-'));
  const hub = await fakeHub();
  try {
    let run = await runCli([CLI, '--json', 'init'], {
      cwd: repo,
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    writeTestCredential(home, hub.base, 'sk_join.secret');
    run = await runCli([
      CLI,
      '--json',
      'connect',
      '--remote',
      hub.base,
      '--project',
      'tnt_existing',
    ], {
      cwd: repo,
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).remote.project, 'tnt_existing');
  } finally {
    await hub.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
