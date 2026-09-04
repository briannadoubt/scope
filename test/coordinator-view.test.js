import test from 'node:test';
import assert from 'node:assert/strict';
import { createTempScope } from './helpers.js';
import { createTicket, addRelation } from '../src/repo.js';
import { claimTicket, createHandoff, setContract, parallelPlan, addDiscovery, finishAttempt } from '../src/agent-runtime.js';
import { coordinatorView } from '../src/coordinator-view.js';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
function collect(db, options = {}) {
  const pages = [];
  let cursor;
  do {
    const page = coordinatorView(db, { ...options, cursor });
    assert.ok(bytes(page) <= (options.budgetBytes ?? 16384));
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(pages.at(-1).complete, true);
  return { pages, records: pages.flatMap((page) => page.records) };
}

test('compact pagination retains every conflict, blocker and ticket in deterministic order', () => {
  const { db, cleanup } = createTempScope();
  try {
    const tickets = Array.from({ length: 9 }, (_, i) => {
      const ticket = createTicket(db, { type: 'story', title: `Task ${i}`, description: 'large narrative '.repeat(1000) });
      setContract(db, ticket.id, { policy: { files: ['src/shared.js'] } });
      return ticket;
    });
    addRelation(db, tickets[8].id, tickets[0].id, 'blocked_by');
    const full = parallelPlan(db);
    const first = collect(db, { budgetBytes: 2048 });
    assert.ok(first.pages.length > 1);
    assert.deepEqual(first.records.filter((r) => r.section === 'conflicts').map((r) => r.value), full.conflicts);
    assert.equal(first.records.filter((r) => r.section === 'tickets').length, 9);
    assert.ok(first.records.some((r) => r.section === 'blockers' && r.value.id === tickets[0].id));
    for (const [section, count] of Object.entries(first.pages[0].totals)) {
      assert.equal(first.records.filter((r) => r.section === section).length, count);
    }
    assert.deepEqual(collect(db, { budgetBytes: 2048 }), first);
    const unchanged = coordinatorView(db, { since: first.pages[0].snapshot });
    assert.equal(unchanged.unchanged, true);
    assert.deepEqual(unchanged.records, []);
    createTicket(db, { type: 'story', title: 'New work' });
    assert.throws(() => coordinatorView(db, { cursor: first.pages[0].nextCursor }), (e) => e.code === 'STALE_CURSOR');
    assert.equal(coordinatorView(db, { since: first.pages[0].snapshot }).unchanged, false);
  } finally { cleanup(); }
});

test('compact handoff removes repeated narratives but retains blockers and lifecycle references', () => {
  const { db, cleanup } = createTempScope();
  try {
    const ticket = createTicket(db, { type: 'story', title: 'Implementation' });
    setContract(db, ticket.id, { verificationCommands: ['acceptance'], policy: { files: ['src/a.js'] } });
    const claim = claimTicket(db, ticket.id, { agent: 'worker', files: ['src/a.js'] });
    createHandoff(db, ticket.id, { agent: 'worker', summary: 'narrative '.repeat(20000), blockers: ['Needs integration'], remaining: ['Acceptance'] });
    const view = collect(db);
    assert.ok(view.records.some((r) => r.section === 'blockers' && r.value.body === 'Needs integration'));
    const row = view.records.find((r) => r.section === 'tickets').value;
    assert.equal(row.execution.phase, 'handed_off');
    assert.equal(row.execution.attemptId, claim.attempt.attemptId);
    assert.equal(row.execution.verification.satisfied, false);
    assert.ok(bytes(view.pages) < bytes(parallelPlan(db)) / 20);
    const second = claimTicket(db, ticket.id, { agent: 'integrator' });
    finishAttempt(db, second.attempt.attemptId, { agent: 'integrator', outcome: 'succeeded' });
    const succeeded = collect(db).records.find((r) => r.section === 'tickets').value;
    assert.equal(succeeded.status, 'in_review');
    assert.equal(succeeded.execution.phase, 'succeeded');
    assert.equal(succeeded.execution.verification.satisfied, false, 'worker success does not imply acceptance');
  } finally { cleanup(); }
});

test('compact cursors invalidate on lease expiry and oversized records fail explicitly', () => {
  const { db, cleanup } = createTempScope();
  try {
    const ticket = createTicket(db, { type: 'story', title: 'Working' });
    const now = new Date('2026-09-04T00:00:00Z');
    claimTicket(db, ticket.id, { agent: 'worker', now, ttl: '1s' });
    const initial = coordinatorView(db, { now });
    assert.equal(coordinatorView(db, { now: new Date(now.getTime() + 1001), since: initial.snapshot }).unchanged, false);
    addDiscovery(db, ticket.id, { type: 'blocker', body: 'BLOCKER'.repeat(1000) });
    assert.throws(() => collect(db, { budgetBytes: 2048 }), (e) => e.code === 'COORDINATOR_RECORD_TOO_LARGE');
    assert.throws(() => coordinatorView(db, { budgetBytes: NaN }), /budgetBytes/);
    assert.throws(() => coordinatorView(db, { cursor: 'garbage' }), /invalid coordinator cursor/);
    assert.throws(() => coordinatorView(db, { cursor: `${initial.snapshot}:0`, since: initial.snapshot }), /cannot be combined/);
  } finally { cleanup(); }
});
