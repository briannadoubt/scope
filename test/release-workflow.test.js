import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
);

test('npm release uses stage-only OIDC without a long-lived publish token', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm install --global npm@12\.0\.2/);
  assert.match(workflow, /npm stage publish --provenance --access public/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|secrets\.NPM_TOKEN/);
  assert.doesNotMatch(workflow, /run: npm publish/);
});

test('downstream release steps wait until the staged npm version is public', () => {
  const stageIndex = workflow.indexOf('npm stage publish');
  const approvalIndex = workflow.indexOf('Wait for npm malware scan and maintainer 2FA approval');
  const homebrewIndex = workflow.indexOf('Fetch sha256 of GitHub source tarball');

  assert.ok(stageIndex >= 0);
  assert.ok(approvalIndex > stageIndex);
  assert.ok(homebrewIndex > approvalIndex);
  assert.match(workflow, /npm view "scope-kanban@\$\{VERSION\}" version/);
});
