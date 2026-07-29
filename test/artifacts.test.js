import test from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createTempScope, startTestServer, apiFetch } from './helpers.js';
import { openDb } from '../src/db.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { replayInto } from '../src/replay.js';
import {
  createTicket,
  putArtifact,
  listArtifacts,
  getArtifact,
  removeArtifact,
} from '../src/repo.js';
import { ARTIFACT_MAX_BYTES } from '../src/event-schema.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin/scope.js');

test('HTML artifacts emit events and survive a cache replay', () => {
  const s = createTempScope();
  try {
    const ticket = createTicket(s.db, { type: 'story', title: 'Visual', actor: 'bri' });
    const first = putArtifact(s.db, ticket.id, {
      name: 'chart.html',
      content: '<!doctype html><h1>One</h1>',
    }, 'bri', 'Codex');
    const updated = putArtifact(s.db, ticket.id, {
      name: 'chart.html',
      content: '<!doctype html><h1>Two</h1>',
    }, 'bri', 'Codex');

    assert.equal(updated.id, first.id, 'same name replaces the stable artifact');
    assert.equal(listArtifacts(s.db, ticket.id).length, 1);
    assert.match(getArtifact(s.db, ticket.id, first.id).content, /Two/);

    const events = readAllEvents(eventsDir(s.scopeDir));
    const puts = events.filter((e) => e.kind === 'artifact.put');
    assert.equal(puts.length, 2);
    assert.equal(puts[1].payload.ticketId, ticket.uid);
    assert.equal(puts[1].payload.artifactId, first.id);

    s.db.exec('DELETE FROM ticket_artifacts');
    replayInto(s.db, events);
    assert.match(getArtifact(s.db, ticket.id, first.id).content, /Two/);

    assert.equal(removeArtifact(s.db, ticket.id, first.id, 'bri'), true);
    const afterRemove = readAllEvents(eventsDir(s.scopeDir));
    replayInto(s.db, afterRemove);
    assert.equal(listArtifacts(s.db, ticket.id).length, 0, 'remove tombstones the artifact');
  } finally {
    s.cleanup();
  }
});

test('HTML artifact validation enforces MIME type and byte limit', () => {
  const s = createTempScope();
  try {
    const ticket = createTicket(s.db, { type: 'story', title: 'Visual' });
    assert.throws(
      () => putArtifact(s.db, ticket.id, { name: 'x.svg', mimeType: 'image/svg+xml', content: '<svg/>' }),
      /Only text\/html/
    );
    assert.throws(
      () => putArtifact(s.db, ticket.id, { name: 'huge.html', content: 'x'.repeat(ARTIFACT_MAX_BYTES + 1) }),
      /exceeds/
    );
  } finally {
    s.cleanup();
  }
});

test('opening a v6 workspace creates the artifact projection table', () => {
  const s = createTempScope();
  const { scopeDir } = s;
  try {
    s.db.exec("DROP TABLE ticket_artifacts; UPDATE meta SET value='6' WHERE key='schema_version'");
    s.db.close();
    const migrated = openDb(scopeDir);
    try {
      const table = migrated.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ticket_artifacts'"
      ).get();
      assert.equal(table.name, 'ticket_artifacts');
      assert.equal(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '7');
    } finally {
      migrated.close();
    }
  } finally {
    s.cleanup();
  }
});

test('artifact HTTP API serves script-capable HTML with an isolated CSP', async () => {
  const t = await startTestServer();
  try {
    const ticket = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST',
      body: { type: 'story', title: 'Interactive visual' },
    });
    const created = await apiFetch(t.baseUrl, `/api/tickets/${ticket.data.id}/artifacts`, {
      method: 'POST',
      body: { name: 'demo.html', content: '<button onclick="this.textContent=\'ok\'">run</button>' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.mime_type, 'text/html');

    const detail = await apiFetch(t.baseUrl, `/api/tickets/${ticket.data.id}`);
    assert.equal(detail.data.artifacts.length, 1);
    assert.equal(detail.data.artifacts[0].content, undefined, 'ticket detail does not inline artifact bodies');

    const content = await fetch(
      `${t.baseUrl}/api/tickets/${ticket.data.id}/artifacts/${created.data.id}/content`
    );
    assert.equal(content.status, 200);
    assert.match(content.headers.get('content-type'), /^text\/html/);
    const csp = content.headers.get('content-security-policy');
    assert.match(csp, /script-src 'unsafe-inline'/);
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.equal(content.headers.get('x-frame-options'), null);
    assert.match(await content.text(), /onclick/);

    const removed = await apiFetch(
      t.baseUrl,
      `/api/tickets/${ticket.data.id}/artifacts/${created.data.id}`,
      { method: 'DELETE' }
    );
    assert.equal(removed.status, 200);
  } finally {
    await t.close();
  }
});

test('artifact CLI attaches, reads, lists, and removes an HTML file', () => {
  const repo = mkdtempSync(join(tmpdir(), 'scope-artifact-cli-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'scope-artifact-cli-home-'));
  const env = { ...process.env, HOME: home };
  const run = (...args) => spawnSync(process.execPath, [CLI, '--json', ...args], {
    cwd: repo,
    env,
    encoding: 'utf8',
  });
  try {
    let result = run('init', '--key', 'ART', '--name', 'Artifacts');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = run('ticket', 'create', 'Visual ticket');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const ticket = JSON.parse(result.stdout);
    const file = join(repo, 'visual.html');
    writeFileSync(file, '<!doctype html><h1>CLI visual</h1>');

    result = run('artifact', 'add', ticket.id, file, '--by', 'agent');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const artifact = JSON.parse(result.stdout);
    assert.equal(artifact.name, 'visual.html');

    result = run('artifact', 'list', ticket.id);
    assert.equal(JSON.parse(result.stdout).length, 1);
    result = run('artifact', 'show', ticket.id, artifact.id);
    assert.match(JSON.parse(result.stdout).content, /CLI visual/);
    result = run('artifact', 'remove', ticket.id, artifact.id, '--by', 'agent');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    result = run('artifact', 'list', ticket.id);
    assert.deepEqual(JSON.parse(result.stdout), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
