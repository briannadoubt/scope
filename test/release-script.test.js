import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const releaseScript = await readFile(
  new URL('../scripts/release.sh', import.meta.url),
  'utf8',
);

test('release wrapper explicitly pushes its lightweight release tag', () => {
  assert.match(releaseScript, /git push origin "\$BRANCH" "\$NEW_VERSION"/);
  assert.doesNotMatch(releaseScript, /git push origin "\$BRANCH" --follow-tags/);
});

test('release wrapper refreshes and stages versioned agent documentation', () => {
  const versionIndex = releaseScript.indexOf('npm version');
  const docsIndex = releaseScript.indexOf('npm run docs:agent');
  const commitIndex = releaseScript.indexOf('git commit');

  assert.ok(versionIndex >= 0);
  assert.ok(docsIndex > versionIndex);
  assert.ok(commitIndex > docsIndex);
  assert.match(
    releaseScript,
    /git add package\.json package-lock\.json docs\/agent-protocol\.md/,
  );
});
