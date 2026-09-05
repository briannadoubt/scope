import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isIgnorableLocalScopeEntry,
  releaseBlockingEntries,
} from '../scripts/check-release-tree.mjs';

test('release tree ignores only untracked generated Scope events and receipts', () => {
  assert.equal(isIgnorableLocalScopeEntry('?? .scope/events/01M1ST6W3WT63QCEQEZCWMHJMV.json'), true);
  assert.equal(isIgnorableLocalScopeEntry(`?? .scope/receipts/${'a'.repeat(64)}.json`), true);

  assert.equal(isIgnorableLocalScopeEntry(' M .scope/events/01M1ST6W3WT63QCEQEZCWMHJMV.json'), false);
  assert.equal(isIgnorableLocalScopeEntry('?? .scope/events/not-an-event.json'), false);
  assert.equal(isIgnorableLocalScopeEntry('?? .scope/workspace.json'), false);
  assert.equal(isIgnorableLocalScopeEntry('?? release-notes.md'), false);
});

test('release tree preserves tracked and unrelated untracked blockers', () => {
  const status = [
    '?? .scope/events/01M1ST6W3WT63QCEQEZCWMHJMV.json',
    `?? .scope/receipts/${'b'.repeat(64)}.json`,
    ' M src/cli.js',
    '?? notes.txt',
    'D  docs/guide.md',
    '',
  ].join('\0');

  assert.deepEqual(releaseBlockingEntries(status), [
    ' M src/cli.js',
    '?? notes.txt',
    'D  docs/guide.md',
  ]);
});
