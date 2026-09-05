#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LOCAL_SCOPE_STATE = [
  /^\.scope\/events\/[0-9A-Z]{26}\.json$/,
  /^\.scope\/receipts\/[0-9a-f]{64}\.json$/,
];

export function isIgnorableLocalScopeEntry(entry) {
  if (!entry.startsWith('?? ')) return false;
  const path = entry.slice(3);
  return LOCAL_SCOPE_STATE.some((pattern) => pattern.test(path));
}

export function releaseBlockingEntries(porcelain) {
  return String(porcelain)
    .split('\0')
    .filter(Boolean)
    .filter((entry) => !isIgnorableLocalScopeEntry(entry));
}

export function checkReleaseTree({ cwd = process.cwd() } = {}) {
  const result = spawnSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd, encoding: 'utf8' }
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'Unable to inspect the Git working tree.\n');
    return 1;
  }

  const blockers = releaseBlockingEntries(result.stdout);
  if (!blockers.length) return 0;

  for (const entry of blockers) process.stdout.write(`${entry}\n`);
  return 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = checkReleaseTree();
}
