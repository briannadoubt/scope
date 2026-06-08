import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { WorkspaceManager } from '../src/workspaces.js';

/**
 * SCP-105 — detach must close the fs.watch watcher that attach opened, and the
 * test helper's close() now calls detach so server-backed tests don't leak a
 * live watcher + file handle on a deleted temp dir.
 */
test('detach closes the fs.watch watcher and removes the workspace', () => {
  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });

  let closed = false;
  if (ws.watcher && typeof ws.watcher.close === 'function') {
    const orig = ws.watcher.close.bind(ws.watcher);
    ws.watcher.close = () => { closed = true; orig(); };
  }

  mgr.detach(ws.id, { persist: false, broadcast: false });

  assert.equal(mgr.get(ws.id), null, 'workspace removed from the manager');
  if (ws.watcher) assert.ok(closed, 'fs.watch watcher was closed');
  scope.cleanup();
});
