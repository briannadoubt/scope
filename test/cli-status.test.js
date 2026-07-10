import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { openDb } from '../src/db.js';
import { updateWorkspace } from '../src/repo.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/scope.js');

const customColumns = [
  { id: 'triage', label: 'Triage', color: '#ca8a04', kind: 'open', order: 10 },
  { id: 'building', label: 'Building', color: '#2563eb', kind: 'open', order: 20 },
  { id: 'shipped', label: 'Shipped', color: '#16a34a', kind: 'done', order: 30 },
];

function runCli(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], options);
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

test('CLI accepts workspace-defined status ids', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'scope-cli-status-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'scope-cli-status-home-'));
  try {
    let run = await runCli(['--json', 'init', '--key', 'STA', '--name', 'Status CLI'], {
      cwd: repo,
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    const oldHome = process.env.HOME;
    process.env.HOME = home;
    const db = openDb(join(repo, '.scope'));
    try {
      updateWorkspace(db, { columns: customColumns });
    } finally {
      db.close();
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }

    run = await runCli(['--json', 'ticket', 'create', 'Dynamic status', '--status', 'building'], {
      cwd: repo,
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).status, 'building');

    run = await runCli(['--json', 'ticket', 'edit', 'STA-1', '--status', 'shipped'], {
      cwd: repo,
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).status, 'shipped');

    run = await runCli(['--json', 'ticket', 'list', '--status', 'shipped'], {
      cwd: repo,
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const tickets = JSON.parse(run.stdout);
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].id, 'STA-1');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
