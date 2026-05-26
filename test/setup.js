// Test bootstrap. Loaded via `node --import` before any test file imports
// project source. Reroutes $HOME to a temp dir so the auth-token and workspace
// registry helpers (auth.js, workspaces.js) don't write to the real ~/.scope-hub
// during tests.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.SCOPE_TEST_HOME_SET) {
  const dir = mkdtempSync(join(tmpdir(), 'scope-test-home-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir; // Windows
  process.env.SCOPE_TEST_HOME_SET = '1';
}
