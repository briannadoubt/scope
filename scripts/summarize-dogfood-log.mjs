import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const path = process.argv.find((arg, index) => index > 1 && !arg.startsWith('--'))
  || process.env.SCOPE_DOGFOOD_LOG;
const asJson = process.argv.includes('--json');

if (!path || !existsSync(path)) {
  process.stderr.write('Usage: npm run dogfood:report -- <usage.ndjson> [--json]\n');
  process.exit(1);
}

const records = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const groups = new Map();
for (const record of records) {
  const key = `${record.surface}:${record.operation}`;
  const group = groups.get(key) || { surface: record.surface, operation: record.operation, count: 0, errors: 0, durations: [] };
  group.count += 1;
  if (record.outcome === 'error') group.errors += 1;
  if (Number.isFinite(record.durationMs)) group.durations.push(record.durationMs);
  groups.set(key, group);
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
const operations = [...groups.values()].map((group) => ({
  surface: group.surface,
  operation: group.operation,
  count: group.count,
  errors: group.errors,
  errorRate: group.count ? Number((group.errors / group.count).toFixed(4)) : 0,
  averageMs: group.durations.length
    ? Math.round(group.durations.reduce((sum, value) => sum + value, 0) / group.durations.length)
    : 0,
  p95Ms: percentile(group.durations, 0.95),
})).sort((a, b) => b.count - a.count || a.operation.localeCompare(b.operation));

const bridgeStatePath = process.env.SCOPE_BRIDGE_STATE
  || join(process.env.SCOPE_HOME || join(process.env.HOME || homedir(), '.scope'), 'bridge-state.json');
let sessionBridge = null;
if (existsSync(bridgeStatePath)) {
  try {
    const state = JSON.parse(readFileSync(bridgeStatePath, 'utf8'));
    const deliveries = Object.values(state.deliveries || {}).filter((item) => item && typeof item === 'object');
    const statusCounts = {};
    const errorCodes = {};
    const durations = [];
    for (const delivery of deliveries) {
      const status = String(delivery.status || 'unknown');
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      if (/^BRIDGE_[A-Z_]+$/.test(delivery.errorCode || '')) {
        errorCodes[delivery.errorCode] = (errorCodes[delivery.errorCode] || 0) + 1;
      }
      if (Number.isFinite(delivery.durationMs)) durations.push(delivery.durationMs);
    }
    const heartbeat = Date.parse(state.runner?.heartbeatAt || '');
    const failed = statusCounts.retrying || 0;
    const acknowledged = statusCounts.acknowledged || 0;
    sessionBridge = {
      runnerConnected: Number.isFinite(heartbeat) && Date.now() - heartbeat <= 10_000,
      deliveries: deliveries.length,
      acknowledged,
      retrying: failed,
      failureRate: deliveries.length ? Number((failed / deliveries.length).toFixed(4)) : 0,
      averageMs: durations.length
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : 0,
      p95Ms: percentile(durations, 0.95),
      statusCounts,
      errorCodes,
    };
  } catch {
    sessionBridge = { unreadable: true };
  }
}

const report = {
  records: records.length,
  from: records[0]?.timestamp ?? null,
  through: records.at(-1)?.timestamp ?? null,
  errors: records.filter((record) => record.outcome === 'error').length,
  operations,
  sessionBridge,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`Scope dogfood: ${report.records} operations, ${report.errors} errors\n`);
  process.stdout.write(`${report.from || 'n/a'} → ${report.through || 'n/a'}\n\n`);
  process.stdout.write('COUNT  ERR  AVGms  P95ms  SURFACE  OPERATION\n');
  for (const row of operations) {
    process.stdout.write(
      `${String(row.count).padStart(5)}  ${String(row.errors).padStart(3)}  ` +
      `${String(row.averageMs).padStart(5)}  ${String(row.p95Ms).padStart(5)}  ` +
      `${row.surface.padEnd(7)}  ${row.operation}\n`
    );
  }
  if (sessionBridge) {
    process.stdout.write('\nSession bridge (privacy-bounded)\n');
    if (sessionBridge.unreadable) {
      process.stdout.write('state unreadable\n');
    } else {
      process.stdout.write(
        `${sessionBridge.runnerConnected ? 'connected' : 'offline'} · ` +
        `${sessionBridge.deliveries} deliveries · ${sessionBridge.acknowledged} acknowledged · ` +
        `${sessionBridge.retrying} retrying · ${sessionBridge.averageMs}ms avg · ${sessionBridge.p95Ms}ms p95\n`
      );
      const codes = Object.entries(sessionBridge.errorCodes);
      if (codes.length) process.stdout.write(`safe errors: ${codes.map(([code, count]) => `${code}=${count}`).join(', ')}\n`);
    }
  }
}
