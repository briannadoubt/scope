import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { createTempScope } from './helpers.js';
import { ensureEventLog } from '../src/backfill.js';
import { registerAgent, sendMessage } from '../src/agent-mailbox.js';

test('message listen emits addressed wakeups as JSONL', async () => {
  const scope = createTempScope();
  let child;
  try {
    ensureEventLog(scope.db, scope.scopeDir);
    registerAgent(scope.db, 'codex:sol', { provider: 'openai' });
    registerAgent(scope.db, 'claude:opus', { provider: 'anthropic' });
    child = spawn(process.execPath, [resolve('bin/scope.js'), 'message', 'listen', 'claude:opus'], {
      env: { ...process.env, SCOPE_DIR: scope.scopeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = new Promise((resolveLine, reject) => {
      let buffer = '';
      let stderr = '';
      const timeout = setTimeout(() => reject(new Error(`listener timeout: ${stderr}`)), 5000);
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        resolveLine(JSON.parse(buffer.slice(0, newline)));
      });
      child.once('exit', (code) => {
        if (code && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`listener exited ${code}: ${stderr}`));
        }
      });
    });
    const sent = sendMessage(scope.db, {
      fromAgent: 'codex:sol', toAgent: 'claude:opus', body: 'Wake up and review the change.',
    });
    const envelope = await line;
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.messageId, sent.messageId);
    assert.equal(envelope.meta.delivery, 'at-least-once');
  } finally {
    child?.kill('SIGTERM');
    scope.cleanup();
  }
});
