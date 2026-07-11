import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openWorkspaceDb } from '../src/workspace-open.js';
import { openWorkspace } from '../src/index.js';
import { createTicket, updateWorkspace, listTickets } from '../src/repo.js';

// The CLI (`openOrDie`), the hub registry (`WorkspaceManager.attach`), and the
// library facade (`openWorkspace`) all funnel through openWorkspaceDb so they
// can't drift on how a workspace is brought up. These tests pin the canonical
// sequence and prove the library really goes through it.

test('openWorkspaceDb runs the full open sequence (gitignore + rebuild-from-log)', () => {
  const scopeDir = mkdtempSync(join(tmpdir(), 'scope-open-'));
  try {
    // First open bootstraps the workspace, gitignore, and authoritative log.
    let { db } = openWorkspaceDb(scopeDir);
    updateWorkspace(db, { key: 'OPN', name: 'Open' });
    createTicket(db, { type: 'story', title: 'Survivor', actor: 'bri' });
    const dbPath = db.name;
    db.close();

    // ensureScopeGitignore step ran.
    assert.ok(existsSync(join(scopeDir, '.gitignore')), '.scope/.gitignore written');

    // Delete the cache but keep the event log → the log is now ahead.
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    assert.equal(existsSync(dbPath), false);

    // Re-open through the shared helper: the syncFromLog step must replay it.
    ({ db } = openWorkspaceDb(scopeDir));
    const rows = listTickets(db);
    assert.equal(rows.length, 1, 'cache rebuilt from the log');
    assert.equal(rows[0].title, 'Survivor');
    db.close();
  } finally {
    rmSync(scopeDir, { recursive: true, force: true });
  }
});

test('the library facade shares the sequence (rebuilds a cache that is behind)', () => {
  const scopeDir = mkdtempSync(join(tmpdir(), 'scope-open-lib-'));
  try {
    // Seed via the helper so we can capture the real db path (the library
    // handle deliberately does not expose db).
    const { db } = openWorkspaceDb(scopeDir);
    updateWorkspace(db, { key: 'LIB', name: 'Lib' });
    createTicket(db, { type: 'bug', title: 'Rebuilt', actor: 'x' });
    const dbPath = db.name;
    db.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });

    // Open through the library: if it routes through the full sequence it will
    // replay the log into the freshly-recreated cache.
    const ws = openWorkspace(scopeDir);
    const rows = ws.listTickets({});
    assert.equal(rows.length, 1, 'library rebuilt the cache from the log');
    assert.equal(rows[0].title, 'Rebuilt');
    ws.close();
  } finally {
    rmSync(scopeDir, { recursive: true, force: true });
  }
});
