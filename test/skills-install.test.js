import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'skills', 'install.sh');
const SKILLS = join(ROOT, 'skills');

test('Codex skill install is user-wide, current, idempotent, and preserves unrelated guidance', () => {
  const home = mkdtempSync(join(tmpdir(), 'scope-skills-home-'));
  const guidance = join(home, '.codex', 'AGENTS.md');
  try {
    mkdirSync(dirname(guidance), { recursive: true });
    writeFileSync(guidance, [
      '# Personal guidance',
      '<!-- BEGIN scope kanban guidance -->',
      'stale Scope content',
      '<!-- END scope kanban guidance -->',
      'Keep this unrelated line.',
    ].join('\n'));
    const run = () => spawnSync('bash', [SCRIPT, '--tool', 'codex'], {
      env: { ...process.env, HOME: home, SCOPE_SKILLS_DIR: SKILLS },
      encoding: 'utf8',
    });

    let result = run();
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = run();
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const installedSkill = readFileSync(join(home, '.agents', 'skills', 'scope', 'SKILL.md'), 'utf8');
    assert.equal(installedSkill, readFileSync(join(SKILLS, 'scope.md'), 'utf8'));
    assert.match(installedSkill, /^---\nname: scope\n/);
    assert.doesNotMatch(installedSkill, /Native Claude subagents/);
    const installedGuidance = readFileSync(guidance, 'utf8');
    assert.match(installedGuidance, /# Personal guidance/);
    assert.match(installedGuidance, /Keep this unrelated line\./);
    assert.doesNotMatch(installedGuidance, /stale Scope content/);
    assert.equal((installedGuidance.match(/BEGIN scope kanban guidance/g) || []).length, 1);
    assert.equal((installedGuidance.match(/END scope kanban guidance/g) || []).length, 1);
    assert.match(installedGuidance, /minimumReaderVersion/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
