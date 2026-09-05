import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTempScope, startTestServer, apiFetch } from './helpers.js';
import { createTicket, updateTicket } from '../src/repo.js';
import { addDiscovery, claimTicket, contextPack, createHandoff, setContract } from '../src/agent-runtime.js';
import { acquireResources } from '../src/agent-resources.js';

function bounded(page, budget) {
  const text = JSON.stringify(page);
  assert.equal(page.outputBytes, Buffer.byteLength(text));
  assert.equal(page.approximateTokens, Math.ceil(text.length / 4));
  assert.ok(page.outputBytes <= budget * 4, `${page.outputBytes} exceeds ${budget * 4}`);
}

function pages(db, id, budget, options = {}) {
  const result = [];
  let page = contextPack(db, id, { budget, ...options });
  do {
    bounded(page, budget);
    result.push(page);
    if (!page.nextCursor) break;
    assert.equal(page.cursor, null);
    assert.ok(result.length < 1000);
    page = contextPack(db, id, { budget, cursor: page.nextCursor });
  } while (true);
  return result;
}

function detail(db, id, ref, budget = 512) {
  let page = contextPack(db, id, { budget, detail: ref });
  let text = '';
  do {
    bounded(page, budget);
    assert.equal(page.offset, text.length);
    text += page.text;
    if (!page.nextCursor) break;
    assert.equal(page.complete, false);
    page = contextPack(db, id, { budget, cursor: page.nextCursor });
  } while (true);
  assert.equal(text.length, page.totalChars);
  assert.equal(page.complete, true);
  return JSON.parse(text);
}

test('SCP-339: large handoffs fit the budget, occur once in the index, and remain retrievable', () => {
  const { db, cleanup } = createTempScope();
  try {
    const ticket = createTicket(db, { type: 'story', title: 'Budget probe', description: 'context '.repeat(1500) });
    setContract(db, ticket.id, { policy: { files: ['src/probe.js'] } });
    claimTicket(db, ticket.id, { agent: 'probe', files: ['src/probe.js'] });
    const handed = createHandoff(db, ticket.id, { agent: 'probe', summary: 'implementation evidence '.repeat(1200), remaining: ['Run acceptance'], blockers: [] });
    const result = pages(db, ticket.id, 2000);
    assert.equal(result[0].view, 'context-v2');
    assert.equal(result[0].truncated, true);
    const records = result.flatMap((page) => page.records);
    assert.equal(JSON.stringify(records).includes('implementation evidence'), false);
    const discoveries = records.filter((record) => record.section === 'discoveries');
    assert.equal(discoveries.length, 1);
    assert.equal(discoveries[0].id, handed.handoff.discoveryId);
    assert.equal(detail(db, ticket.id, discoveries[0].detail.ref).body, handed.handoff.body);
    const storedTicket = detail(db, ticket.id, records.find((record) => record.section === 'ticket').detail.ref);
    assert.equal(storedTicket.description, ticket.description);
    assert.ok(result.at(-1).cursor);
  } finally { cleanup(); }
});

test('pages retain every change and only publish a new since cursor after the last page', () => {
  const { db, cleanup } = createTempScope();
  try {
    const ticket = createTicket(db, { type: 'story', title: 'Many changes' });
    const initial = contextPack(db, ticket.id).cursor;
    const expected = [];
    for (let i = 0; i < 35; i++) expected.push(addDiscovery(db, ticket.id, { type: 'fact', body: `Fact ${i}` }).discoveryId);
    const result = pages(db, ticket.id, 512, { since: initial });
    assert.ok(result.length > 1);
    const records = result.flatMap((page) => page.records);
    const changes = records.filter((r) => r.section === 'changes').map((r) => r.value ?? detail(db, ticket.id, r.detail.ref));
    assert.equal(changes.length, 35);
    assert.equal(new Set(changes.map((c) => c.id)).size, 35);
    assert.deepEqual(changes.map((c) => detail(db, ticket.id, c.payload.ref).discoveryId).sort(), expected.sort());
    const final = result.at(-1);
    assert.equal(final.complete, true);
    addDiscovery(db, ticket.id, { type: 'fact', body: 'Next change' });
    const next = contextPack(db, ticket.id, { since: final.cursor, budget: 4000 });
    assert.equal(next.changes.length, 1);
  } finally { cleanup(); }
});

test('Unicode and escaped detail chunks reconstruct exactly at small budgets', () => {
  const { db, cleanup } = createTempScope();
  try {
    const ticket = createTicket(db, { type: 'story', title: 'Unicode', description: '😀漢字\n"\\\u0000'.repeat(400) });
    for (const budget of [256, 512, 2000]) {
      const result = pages(db, ticket.id, budget);
      const record = result.flatMap((p) => p.records).find((r) => r.section === 'ticket');
      assert.equal(detail(db, ticket.id, record.detail.ref, budget).description, ticket.description);
    }
  } finally { cleanup(); }
});

test('invalid budgets/cursors reject; stale pages and changed detail never substitute data', () => {
  const { db, cleanup } = createTempScope();
  try {
    const ticket = createTicket(db, { type: 'story', title: 'Stale', description: 'long '.repeat(2000) });
    for (let i = 0; i < 5; i++) addDiscovery(db, ticket.id, { type: 'fact', body: `Fact ${i}` });
    for (const budget of [0, -1, NaN, Infinity, 2.5, 255, 262145]) assert.throws(() => contextPack(db, ticket.id, { budget }), /budget/);
    assert.throws(() => contextPack(db, ticket.id, { cursor: 'garbage' }), /cursor/);
    assert.throws(() => contextPack(db, ticket.id, { since: 'nonsense' }), /since/);
    const first = contextPack(db, ticket.id, { budget: 256 });
    assert.ok(first.nextCursor);
    assert.throws(() => contextPack(db, ticket.id, { cursor: first.nextCursor, since: '2020-01-01' }), /combined/);
    const record = pages(db, ticket.id, 512).flatMap((p) => p.records).find((r) => r.section === 'ticket');
    updateTicket(db, ticket.id, { description: 'changed' });
    assert.throws(() => contextPack(db, ticket.id, { cursor: first.nextCursor }), (e) => e.code === 'STALE_CURSOR');
    assert.throws(() => contextPack(db, ticket.id, { detail: record.detail.ref }), (e) => e.code === 'CONTEXT_DETAIL_NOT_FOUND');
  } finally { cleanup(); }
});

test('event cursors include same-millisecond discoveries and lease-only resource events', (t) => {
  const { db, cleanup } = createTempScope();
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-05T10:00:00Z') });
  try {
    const ticket = createTicket(db, { type: 'story', title: 'Event cursor' });
    setContract(db, ticket.id, { policy: { resourceRequirements: { test: [{ key: 'runner' }] } } });
    const claimed = claimTicket(db, ticket.id, { agent: 'probe' });
    const initial = contextPack(db, ticket.id).cursor;
    addDiscovery(db, ticket.id, { type: 'fact', body: 'Same timestamp' });
    acquireResources(db, claimed.lease.leaseId, { agent: 'probe', phase: 'test' });
    const next = contextPack(db, ticket.id, { since: initial, budget: 16000 });
    assert.equal(next.discoveries.length, 1);
    assert.ok(next.changes.some((c) => c.kind === 'agent.resources.set'));
    assert.equal(contextPack(db, ticket.id, { since: '2026-09-05T10:00:00.001Z' }).changes.length, 0);
    assert.equal(contextPack(db, ticket.id, { since: '2026-09-05T03:00:00.001-07:00' }).changes.length, 0);
  } finally { cleanup(); }
});

test('lease expiry invalidates a context page even without an event mutation', (t) => {
  const { db, cleanup } = createTempScope();
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-05T10:00:00Z') });
  try {
    const ticket = createTicket(db, { type: 'story', title: 'Expiry', description: 'large '.repeat(2000) });
    claimTicket(db, ticket.id, { agent: 'probe', ttl: '1s' });
    const first = contextPack(db, ticket.id, { budget: 512 });
    assert.ok(first.nextCursor);
    t.mock.timers.tick(1001);
    assert.throws(() => contextPack(db, ticket.id, { cursor: first.nextCursor }), (e) => e.code === 'STALE_CURSOR');
  } finally { cleanup(); }
});

test('HTTP exposes bounded pages, detail retrieval, and invalid-budget errors', async () => {
  const t = await startTestServer();
  try {
    const ticket = createTicket(t.scope.db, { type: 'story', title: 'HTTP context', description: 'large '.repeat(2000) });
    const base = `/api/agent/tickets/${ticket.id}/context`;
    let response = await apiFetch(t.baseUrl, `${base}?budget=512`);
    const records = [];
    do {
      assert.equal(response.status, 200);
      bounded(response.data, 512);
      records.push(...response.data.records);
      if (!response.data.nextCursor) break;
      response = await apiFetch(t.baseUrl, `${base}?budget=512&cursor=${response.data.nextCursor}`);
    } while (true);
    const ref = records.find((r) => r.section === 'ticket').detail.ref;
    const fetched = await apiFetch(t.baseUrl, `${base}?budget=512&detail=${ref}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.data.view, 'context-detail-v1');
    bounded(fetched.data, 512);
    assert.equal((await apiFetch(t.baseUrl, `${base}?budget=0`)).status, 400);
  } finally { await t.close(); }
});

test('CLI forwards pagination and detail options in machine envelopes', () => {
  const repo = mkdtempSync(join(tmpdir(), 'scope-context-cli-'));
  const home = mkdtempSync(join(tmpdir(), 'scope-context-home-'));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [new URL('../bin/scope.js', import.meta.url).pathname, '--json', ...args], {
      cwd: repo, env: { ...process.env, HOME: home }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout || result.stderr);
    return JSON.parse(result.stdout).data;
  };
  try {
    run('init', '--key', 'CTX', '--name', 'Context');
    const ticket = run('ticket', 'create', 'CLI context', '--description', 'large '.repeat(2000));
    let page = run('context', ticket.id, '--budget', '512');
    const records = [];
    do {
      bounded(page, 512);
      records.push(...page.records);
      if (!page.nextCursor) break;
      page = run('context', ticket.id, '--budget', '512', '--cursor', page.nextCursor);
    } while (true);
    const ref = records.find((r) => r.section === 'ticket').detail.ref;
    bounded(run('context', ticket.id, '--budget', '512', '--detail', ref), 512);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
