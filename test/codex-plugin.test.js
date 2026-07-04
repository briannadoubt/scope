import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const pluginDir = join(root, 'plugins/scope');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('Codex plugin ships a comprehensive manifest and app surfaces', () => {
  const manifest = readJson(join(pluginDir, '.codex-plugin/plugin.json'));

  assert.equal(manifest.name, 'scope');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.apps, './.app.json');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.equal(manifest.interface.displayName, 'Scope');
  assert.match(manifest.interface.longDescription, /inline/i);
  assert.match(manifest.interface.longDescription, /sidebar/i);
  assert.ok(manifest.interface.composerIcon);
  assert.ok(existsSync(join(pluginDir, manifest.interface.composerIcon)));

  const appConfig = readJson(join(pluginDir, '.app.json'));
  assert.ok(appConfig.apps.scope);
  assert.equal(appConfig.apps.scope.id, 'local.scope.kanban');
  assert.equal(appConfig.apps.scope.category, 'Developer tools');

  const mcpConfig = readJson(join(pluginDir, '.mcp.json'));
  assert.deepEqual(mcpConfig.mcpServers.scope.args, ['./mcp/server.mjs', '--stdio']);
  assert.equal(mcpConfig.mcpServers.scope.tool_timeout_sec, 120);
});

test('Codex plugin includes workflow skills and references', () => {
  const expectedSkills = [
    'scope',
    'plan-work',
    'ticket-ops',
    'board-context',
    'git-handoff',
    'multi-agent',
  ];

  for (const name of expectedSkills) {
    const skillPath = join(pluginDir, 'skills', name, 'SKILL.md');
    assert.equal(existsSync(skillPath), true, `${name} skill is missing`);
    const skill = readFileSync(skillPath, 'utf8');
    assert.match(skill, /^---\nname:/);
    assert.match(skill, /scope --json|scope batch|Scope/);
  }

  for (const reference of ['guardrails.md', 'cli-recipes.md', 'ui-surfaces.md']) {
    assert.equal(existsSync(join(pluginDir, 'references', reference)), true);
  }
});

test('npm package includes the Codex plugin bundle', () => {
  const pkg = readJson(join(root, 'package.json'));

  assert.equal(pkg.files.includes('plugins'), true);
});
