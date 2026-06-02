import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync, existsSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createTempScope } from './helpers.js';
import { openDb, ensureScopeGitignore, getMeta } from '../src/db.js';
import { syncFromLog, countEventFiles } from '../src/replay.js';
import { createTicket, updateTicket, listTickets } from '../src/repo.js';

test('syncFromLog rebuilds the cache when scope.db is deleted but the log remains', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'story', title: 'Survivor', actor: 'bri' });
    updateTicket(db, t.id, { status: 'done' }, 'bri');
    const dbPath = db.name;
    db.close();

    // Nuke the cache entirely (the user's "rm scope.db*").
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    assert.equal(existsSync(dbPath), false);

    // Re-open: fresh empty schema, then sync should replay the log.
    const reopened = openDb(scopeDir);
    assert.equal(listTickets(reopened).length, 0, 'fresh cache starts empty');
    const r = syncFromLog(reopened, scopeDir);
    assert.equal(r.rebuilt, true);
    const [survivor] = listTickets(reopened);
    assert.equal(survivor.title, 'Survivor');
    assert.equal(survivor.status, 'done');
    reopened.close();
  } finally {
    cleanup();
  }
});

test('syncFromLog is a no-op when the live writer kept the count in step', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    createTicket(db, { type: 'story', title: 'A' });
    // emit() bumped applied_event_count to match the file count.
    assert.equal(Number(getMeta(db, 'applied_event_count')), countEventFiles(scopeDir));
    const r = syncFromLog(db, scopeDir);
    assert.equal(r.rebuilt, false);
  } finally {
    cleanup();
  }
});

test('syncFromLog rebuilds when the on-disk log is ahead (simulated peer/pull)', () => {
  // Workspace A produces events; copy its log into workspace B (which has never
  // seen them) and confirm B rebuilds to include them.
  const A = createTempScope();
  const B = createTempScope();
  try {
    const t = createTicket(A.db, { type: 'story', title: 'FromPeer', actor: 'peer' });
    updateTicket(A.db, t.id, { status: 'in_progress' }, 'peer');

    // Copy A's event files into B's events dir (what `git pull` would deliver).
    const aEvents = join(A.scopeDir, 'events');
    const bEvents = join(B.scopeDir, 'events');
    rmSync(bEvents, { recursive: true, force: true });
    mkdirSync(bEvents, { recursive: true });
    for (const f of readdirSync(aEvents)) copyFileSync(join(aEvents, f), join(bEvents, f));

    assert.ok(countEventFiles(B.scopeDir) > 0);
    const r = syncFromLog(B.db, B.scopeDir);
    assert.equal(r.rebuilt, true);
    const [imported] = listTickets(B.db);
    assert.equal(imported.title, 'FromPeer');
    assert.equal(imported.status, 'in_progress');
  } finally {
    A.cleanup();
    B.cleanup();
  }
});

test('ensureScopeGitignore writes ignore rules that keep events/ but drop scope.db', () => {
  const { scopeDir, cleanup } = createTempScope();
  try {
    rmSync(join(scopeDir, '.gitignore'), { force: true });
    ensureScopeGitignore(scopeDir);
    const gi = readFileSync(join(scopeDir, '.gitignore'), 'utf8');
    assert.match(gi, /scope\.db/);
    assert.match(gi, /scope\.db-wal/);
    assert.doesNotMatch(gi, /^events\/?$/m, 'events/ must NOT be ignored');
  } finally {
    cleanup();
  }
});
