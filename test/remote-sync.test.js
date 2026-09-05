import assert from 'node:assert/strict';
import test from 'node:test';

import { startRemoteSync } from '../src/remote-sync.js';

test('stop prevents an in-flight sync from publishing post-stop state', async () => {
  let settleSync;
  let markSyncStarted;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const syncImpl = async () => {
    markSyncStarted();
    return new Promise((resolve) => {
      settleSync = resolve;
    });
  };

  let sseClosed = false;
  const agent = startRemoteSync({}, '/unused', {
    remote: 'https://scope.test',
    project: 'project-1',
    syncImpl,
    connectImpl: () => ({ close: () => { sseClosed = true; } }),
    intervalMs: 60_000,
  });

  await syncStarted;
  assert.equal(agent.status().running, true);

  agent.stop();
  const roundsAtStop = agent.status().rounds;
  settleSync({ pushed: 1, pulled: 1, applied: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sseClosed, true);
  assert.equal(agent.status().stopped, true);
  assert.equal(agent.status().running, false);
  assert.equal(agent.status().rounds, roundsAtStop);
  assert.equal(agent.status().pushed, 0);
  assert.equal(agent.status().pulled, 0);
});
