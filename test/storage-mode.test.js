import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { openDb, ensureScopeGitignore, DB_FILE_NAME } from '../src/db.js';
import { ensureEventLog } from '../src/backfill.js';
import { eventsDir, eventsDirForDb } from '../src/event-store.js';
import { createTicket, listTickets } from '../src/repo.js';
import {
  ensureWorkspaceStorageConfig,
  localWorkspaceDataDir,
  readWorkspaceStorageConfig,
  migrateEventsToGit,
  migrateEventsToLocal,
  workspaceConfigPath,
} from '../src/workspace-storage.js';

function tempScope() {
  const root = mkdtempSync(join(tmpdir(), 'scope-storage-'));
  const scopeDir = join(root, '.scope');
  mkdirSync(scopeDir, { recursive: true });
  return {
    root,
    scopeDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(homedir(), '.scope'), { recursive: true, force: true });
    },
  };
}

test('quiet storage keeps scope.db and events in machine-local data', () => {
  const t = tempScope();
  try {
    const cfg = ensureWorkspaceStorageConfig(t.scopeDir, { mode: 'local' });
    const dataDir = localWorkspaceDataDir(t.scopeDir, cfg);
    const db = openDb(t.scopeDir);
    try {
      createTicket(db, { type: 'story', title: 'quiet' });
      ensureEventLog(db, t.scopeDir);
      assert.equal(db.name, join(dataDir, DB_FILE_NAME));
      assert.equal(eventsDir(t.scopeDir), join(dataDir, 'events'));
      assert.equal(eventsDirForDb(db), join(dataDir, 'events'));
      assert.equal(existsSync(join(t.scopeDir, DB_FILE_NAME)), false);
      assert.equal(existsSync(join(t.scopeDir, 'events')), false);
      assert.equal(listTickets(db).length, 1);
    } finally {
      db.close();
    }
  } finally {
    t.cleanup();
  }
});

test('repo-local git-events mode preserves the old .scope/events layout', () => {
  const t = tempScope();
  try {
    ensureWorkspaceStorageConfig(t.scopeDir, { mode: 'git' });
    const db = openDb(t.scopeDir);
    try {
      ensureEventLog(db, t.scopeDir);
      assert.equal(db.name, join(t.scopeDir, DB_FILE_NAME));
      assert.equal(eventsDir(t.scopeDir), join(t.scopeDir, 'events'));
      assert.equal(existsSync(join(t.scopeDir, 'events')), true);
    } finally {
      db.close();
    }
  } finally {
    t.cleanup();
  }
});

test('migrateEventsToLocal copies repo events, rebuilds local cache, and gitignores events', () => {
  const t = tempScope();
  try {
    ensureWorkspaceStorageConfig(t.scopeDir, { mode: 'git' });
    writeFileSync(join(t.scopeDir, '.gitignore'), 'custom.tmp\n');
    let db = openDb(t.scopeDir);
    createTicket(db, { type: 'story', title: 'move me' });
    ensureEventLog(db, t.scopeDir);
    db.close();

    const result = migrateEventsToLocal(t.scopeDir);
    assert.equal(result.mode, 'local');
    assert.ok(result.copied > 0);
    assert.equal(existsSync(join(t.scopeDir, 'events')), false, 'repo events were removed after backup');
    const gi = readFileSync(join(t.scopeDir, '.gitignore'), 'utf8');
    assert.match(gi, /^events\/?$/m);
    assert.match(gi, /^custom\.tmp$/m, 'custom ignore rules are preserved');
    assert.equal(readWorkspaceStorageConfig(t.scopeDir).storage.mode, 'local');

    db = openDb(t.scopeDir);
    try {
      assert.equal(listTickets(db).some((ticket) => ticket.title === 'move me'), true);
    } finally {
      db.close();
    }
  } finally {
    t.cleanup();
  }
});

test('migrateEventsToLocal refuses a divergent existing local event store', () => {
  const t = tempScope();
  try {
    const cfg = ensureWorkspaceStorageConfig(t.scopeDir, { mode: 'git' });
    const db = openDb(t.scopeDir);
    createTicket(db, { type: 'story', title: 'repo event' });
    ensureEventLog(db, t.scopeDir);
    db.close();

    const localEvents = join(localWorkspaceDataDir(t.scopeDir, cfg), 'events');
    mkdirSync(localEvents, { recursive: true });
    writeFileSync(join(localEvents, '01ARZ3NDEKTSV4RRFFQ69G5FAV.json'), JSON.stringify({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      ts: '2026-01-01T00:00:00.000Z',
      actor: 'other',
      kind: 'workspace.init',
      data: { key: 'OTH', name: 'Other' },
    }, null, 2));

    assert.throws(() => migrateEventsToLocal(t.scopeDir), /already has different events/);
    assert.equal(readWorkspaceStorageConfig(t.scopeDir).storage.mode, 'git');
    assert.equal(existsSync(join(t.scopeDir, 'events')), true, 'repo events remain authoritative');
  } finally {
    t.cleanup();
  }
});

test('migrateEventsToGit restores repo events as an explicit advanced mode', () => {
  const t = tempScope();
  try {
    ensureWorkspaceStorageConfig(t.scopeDir, { mode: 'local' });
    let db = openDb(t.scopeDir);
    createTicket(db, { type: 'story', title: 'portable' });
    ensureEventLog(db, t.scopeDir);
    db.close();

    const result = migrateEventsToGit(t.scopeDir);
    assert.equal(result.mode, 'git');
    assert.ok(result.copied > 0);
    assert.equal(readWorkspaceStorageConfig(t.scopeDir).storage.mode, 'git');
    assert.equal(existsSync(join(t.scopeDir, 'events')), true);
    assert.doesNotMatch(readFileSync(join(t.scopeDir, '.gitignore'), 'utf8'), /^events\/?$/m);

    db = openDb(t.scopeDir);
    try {
      assert.equal(listTickets(db).some((ticket) => ticket.title === 'portable'), true);
    } finally {
      db.close();
    }
  } finally {
    t.cleanup();
  }
});

test('workspace storage config is a small committed marker without secrets', () => {
  const t = tempScope();
  try {
    const cfg = ensureWorkspaceStorageConfig(t.scopeDir, { mode: 'local' });
    assert.match(cfg.id, /^ws_/);
    const raw = readFileSync(workspaceConfigPath(t.scopeDir), 'utf8');
    assert.doesNotMatch(raw, /scope\.db|events\/|sk_/);
    assert.deepEqual(JSON.parse(raw).storage, { mode: 'local' });
  } finally {
    t.cleanup();
  }
});
