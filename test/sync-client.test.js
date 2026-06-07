import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, createTempScope } from './helpers.js';
import { updateWorkspace, createTicket, updateTicket } from '../src/repo.js';
import { ensureEventLog } from '../src/backfill.js';
import { eventsDir } from '../src/event-store.js';
import { syncWithRemote } from '../src/sync-client.js';

/**
 * SCP-136 — `scope sync`: push the local log to a remote hub and pull the
 * remote's events back, converging both replicas (ADR 0002). Push is idempotent;
 * pull advances a persisted ULID cursor. Tested end-to-end against a real hub.
 */

const titles = (db) => db.prepare('SELECT title FROM tickets ORDER BY title').all().map((r) => r.title);

test('sync pushes local events to the hub and pulls the hub back — both converge', async () => {
  const s = await startTestServer(); // hub workspace is authoritative (attach -> ensureEventLog)
  try {
    updateWorkspace(s.scope.db, { key: 'TST', name: 'Hub' }, 'hub');
    createTicket(s.scope.db, { type: 'story', title: 'Remote', actor: 'hub' });

    // Local replica B, initialized like the real CLI (openOrDie -> ensureEventLog).
    const b = createTempScope();
    updateWorkspace(b.db, { key: 'TST', name: 'B' }, 'bri');
    createTicket(b.db, { type: 'story', title: 'Local', actor: 'bri' });
    ensureEventLog(b.db, b.scopeDir);

    const r = await syncWithRemote(b.db, b.scopeDir, {
      remote: s.baseUrl,
      remoteWorkspace: s.workspaceId,
    });

    assert.ok(r.pushed >= 1, 'pushed local events');
    assert.ok(r.pulled >= 1, 'pulled remote events');

    // Hub now has the locally-created ticket (pushed in).
    assert.deepEqual(titles(s.scope.db), ['Local', 'Remote'], 'hub converged');
    // B now has the remote ticket (pulled + replayed).
    assert.deepEqual(titles(b.db), ['Local', 'Remote'], 'replica B converged');

    // Re-sync is a no-op push (idempotent) — everything is now a duplicate.
    const r2 = await syncWithRemote(b.db, b.scopeDir, { remote: s.baseUrl, remoteWorkspace: s.workspaceId });
    assert.equal(r2.pushed, 0, 're-sync pushes nothing new');
    assert.ok(r2.duplicates >= 1, 're-sync sees duplicates');
    b.db.close();
  } finally {
    await s.close();
  }
});

test('sync requires a remote URL and workspace', async () => {
  const b = createTempScope();
  try {
    await assert.rejects(() => syncWithRemote(b.db, b.scopeDir, {}), /remote hub URL is required/);
    await assert.rejects(
      () => syncWithRemote(b.db, b.scopeDir, { remote: 'http://x' }),
      /remote workspace id is required/
    );
  } finally {
    b.db.close();
  }
});
