import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('dogfood report includes privacy-bounded session bridge outcomes', () => {
  const home = mkdtempSync(join(tmpdir(), 'scope-report-'));
  try {
    const usage = join(home, 'usage.ndjson');
    const bridge = join(home, 'bridge-state.json');
    writeFileSync(usage, `${JSON.stringify({
      timestamp: '2026-08-27T10:00:00.000Z', surface: 'cli', operation: 'message send',
      outcome: 'success', durationMs: 4,
    })}\n`);
    writeFileSync(bridge, JSON.stringify({
      version: 1,
      runner: { pid: 123, heartbeatAt: new Date().toISOString() },
      deliveries: {
        hiddenA: {
          messageId: 'SECRET_MESSAGE_ID', agentId: 'secret:agent', status: 'acknowledged',
          durationMs: 120, updatedAt: new Date().toISOString(),
        },
        hiddenB: {
          messageId: 'OTHER_SECRET', agentId: 'other:agent', status: 'retrying',
          durationMs: 250, errorCode: 'BRIDGE_SESSION_BUSY', updatedAt: new Date().toISOString(),
        },
      },
    }));
    const result = spawnSync(process.execPath, ['scripts/summarize-dogfood-log.mjs', usage, '--json'], {
      cwd: process.cwd(),
      env: { ...process.env, SCOPE_BRIDGE_STATE: bridge },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sessionBridge.runnerConnected, true);
    assert.equal(report.sessionBridge.acknowledged, 1);
    assert.equal(report.sessionBridge.retrying, 1);
    assert.equal(report.sessionBridge.errorCodes.BRIDGE_SESSION_BUSY, 1);
    assert.equal(result.stdout.includes('SECRET_MESSAGE_ID'), false);
    assert.equal(result.stdout.includes('secret:agent'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
