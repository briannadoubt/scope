import { existsSync, readFileSync } from 'node:fs';

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

const report = {
  records: records.length,
  from: records[0]?.timestamp ?? null,
  through: records.at(-1)?.timestamp ?? null,
  errors: records.filter((record) => record.outcome === 'error').length,
  operations,
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
}
