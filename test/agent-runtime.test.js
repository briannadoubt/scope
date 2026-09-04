import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { ensureEventLog } from '../src/backfill.js';
import { appendEvent, eventsDir, readAllEvents } from '../src/event-store.js';
import { makeEvent } from '../src/event-schema.js';
import { revisionForEvents } from '../src/protocol.js';
import { replayInto } from '../src/replay.js';
import { addRelation, createTicket, getTicket } from '../src/repo.js';
import {
  addDiscovery,
  claimNext,
  claimTicket,
  completeWork,
  contextPack,
  createHandoff,
  executionState,
  finishAttempt,
  getAttempt,
  getContract,
  getLatestHandoff,
  listReady,
  listConflicts,
  parallelPlan,
  readiness,
  renewLease,
  revisePlan,
  resolveConflict,
  setContract,
} from '../src/agent-runtime.js';

test('execution state, derived lifecycle, observed files, and durable handoff stay coherent', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    ensureEventLog(db, scopeDir);
    const ticket = createTicket(db, { type: 'story', title: 'Delegated work', status: 'todo', actor: 'planner' });
    const claimed = claimTicket(db, ticket.id, {
      agent: 'codex:worker-1', ttl: '10m', files: ['src/planned.js'],
    });
    assert.equal(getTicket(db, ticket.id).status, 'in_progress');
    assert.equal(executionState(db, ticket.id).phase, 'running');
    assert.equal(executionState(db, ticket.id).agent, 'codex:worker-1');

    const renewed = renewLease(db, claimed.lease.leaseId, {
      agent: 'codex:worker-1', ttl: '10m', files: ['src/actual.js'],
    });
    assert.deepEqual(renewed.files, ['src/actual.js', 'src/planned.js']);
    addDiscovery(db, ticket.id, { type: 'decision', body: 'Keep the parser boundary', author: 'codex:worker-1' });
    addDiscovery(db, ticket.id, { type: 'blocker', body: 'Needs schema confirmation', author: 'codex:worker-1' });

    const handed = createHandoff(db, ticket.id, {
      agent: 'codex:worker-1',
      attemptId: claimed.attempt.attemptId,
      summary: 'Parser is implemented; schema confirmation remains.',
      toAgent: 'claude:reviewer',
      remaining: ['Confirm schema', 'Run integration tests'],
    });
    assert.equal(handed.attempt.status, 'handed_off');
    assert.equal(getTicket(db, ticket.id).status, 'todo');
    assert.deepEqual(handed.data.decisions, ['Keep the parser boundary']);
    assert.deepEqual(handed.data.blockers, ['Needs schema confirmation']);
    assert.deepEqual(handed.data.files, ['src/actual.js', 'src/planned.js']);
    assert.equal(getLatestHandoff(db, ticket.id).data.toAgent, 'claude:reviewer');
    assert.equal(executionState(db, ticket.id).phase, 'handed_off');
    assert.equal(contextPack(db, ticket.id).handoff.data.remaining.length, 2);
  } finally {
    cleanup();
  }
});

test('parallel planning separates known overlaps, isolates unknown intent, and defers active collisions', () => {
  const { db, cleanup } = createTempScope();
  try {
    const epic = createTicket(db, { type: 'epic', title: 'Parallel work', actor: 'planner' });
    const a = createTicket(db, { type: 'story', title: 'A', parent: epic.id, status: 'todo', actor: 'planner' });
    const b = createTicket(db, { type: 'story', title: 'B', parent: epic.id, status: 'todo', actor: 'planner' });
    const overlap = createTicket(db, { type: 'story', title: 'Overlap', parent: epic.id, status: 'todo', actor: 'planner' });
    const unknown = createTicket(db, { type: 'story', title: 'Unknown', parent: epic.id, status: 'todo', actor: 'planner' });
    const active = createTicket(db, { type: 'story', title: 'Active', parent: epic.id, status: 'todo', actor: 'planner' });
    const deferred = createTicket(db, { type: 'story', title: 'Deferred', parent: epic.id, status: 'todo', actor: 'planner' });
    setContract(db, a.id, { policy: { files: ['src/a.js'] } }, 'planner');
    setContract(db, b.id, { policy: { files: ['src/b.js'] } }, 'planner');
    setContract(db, overlap.id, { policy: { files: ['src/a.js'] } }, 'planner');
    setContract(db, deferred.id, { policy: { files: ['src/active.js'] } }, 'planner');
    claimTicket(db, active.id, { agent: 'running-agent', files: ['src/active.js'] });

    const plan = parallelPlan(db, { parentId: epic.id });
    assert.ok(plan.conflicts.some((item) => item.type === 'candidate_overlap'
      && item.tickets.includes(a.id) && item.tickets.includes(overlap.id)));
    assert.ok(plan.conflicts.some((item) => item.type === 'active_work_overlap'
      && item.tickets[0] === deferred.id));
    assert.ok(plan.deferred.includes(deferred.id));
    assert.ok(plan.unresolvedIntent.includes(unknown.id));
    assert.ok(plan.parallelGroups.some((group) => group.safe && group.tickets.includes(a.id) && group.tickets.includes(b.id)));
    assert.ok(plan.parallelGroups.some((group) => !group.safe && group.tickets[0] === unknown.id));
  } finally {
    cleanup();
  }
});

test('agent runtime coordinates ready work, leases, attempts, policies, context, and replay', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    ensureEventLog(db, scopeDir);
    const epic = createTicket(db, { type: 'epic', title: 'Agent kernel', actor: 'planner' });
    const ready = createTicket(db, { type: 'story', title: 'Ready', parent: epic.id, priority: 'urgent', actor: 'planner' });
    const blocked = createTicket(db, { type: 'story', title: 'Blocked', parent: epic.id, actor: 'planner' });
    addRelation(db, blocked.id, ready.id, 'blocked_by', 'planner');
    setContract(db, ready.id, {
      acceptance: ['tests pass'],
      verificationCommands: ['npm test'],
      requiredCapabilities: ['node'],
      policy: { requireEvidence: true, requireVerification: true, exclusiveFiles: true },
    }, 'planner');

    assert.equal(readiness(db, blocked.id).state, 'blocked');
    assert.equal(listReady(db, { capabilities: [] }).length, 0, 'capability requirement enforced');
    assert.equal(listReady(db, { capabilities: ['node'] })[0].ticket.id, ready.id);

    const claimed = claimNext(db, {
      agent: 'codex-1', capabilities: ['node'], ttl: '10m', files: ['src/repo.js'], parentId: epic.id,
    });
    assert.equal(claimed.ticket.id, ready.id);
    assert.equal(getAttempt(db, claimed.attempt.attemptId).status, 'running');
    assert.equal(readiness(db, ready.id).state, 'claimed');
    assert.throws(() => claimTicket(db, ready.id, { agent: 'codex-2', capabilities: ['node'] }), /not ready/);
    assert.throws(() => finishAttempt(db, claimed.attempt.attemptId, {
      outcome: 'failed', agent: 'codex-2',
    }), /another agent/);
    assert.throws(() => completeWork(db, blocked.id, {
      attemptId: claimed.attempt.attemptId, agent: 'codex-1',
    }), /different ticket/);
    assert.equal(renewLease(db, claimed.lease.leaseId, { agent: 'codex-1', ttl: '30m' }).agent, 'codex-1');

    addDiscovery(db, ready.id, { type: 'decision', body: 'Use committed transactions', data: { reason: 'crash safety' }, author: 'codex-1' });
    assert.equal(revisePlan(db, ready.id, { body: 'Implement then fuzz', actor: 'codex-1' }).version, 1);
    const context = contextPack(db, ready.id, { budget: 2000 });
    assert.equal(context.contract.acceptance[0], 'tests pass');
    assert.equal(context.discoveries[0].type, 'decision');
    addDiscovery(db, ready.id, { type: 'fact', body: 'Incremental context works', author: 'codex-1' });
    const incremental = contextPack(db, ready.id, { since: context.cursor, budget: 2000 });
    assert.equal(incremental.discoveries.length, 1);
    assert.equal(incremental.changes.length, 1);
    assert.equal(incremental.changes[0].kind, 'agent.discovery.add');

    assert.throws(() => completeWork(db, ready.id, {
      attemptId: claimed.attempt.attemptId, agent: 'codex-1', evidence: [], verification: [],
    }), /requires evidence/);
    const completed = completeWork(db, ready.id, {
      attemptId: claimed.attempt.attemptId,
      agent: 'codex-1',
      summary: 'done',
      evidence: [{ commit: 'abc' }],
      verification: [{ command: 'npm test', ok: true }],
      branch: 'feat/agent-kernel',
    });
    assert.equal(completed.ticket.status, 'done');
    assert.equal(completed.attempt.status, 'succeeded');
    assert.throws(() => completeWork(db, ready.id, {
      attemptId: claimed.attempt.attemptId, agent: 'codex-1',
    }), /already succeeded/);

    const events = readAllEvents(eventsDir(scopeDir));
    replayInto(db, events);
    assert.equal(getTicket(db, ready.id).status, 'done');
    assert.equal(getContract(db, ready.id).policy.requireVerification, true);
    assert.equal(getAttempt(db, claimed.attempt.attemptId).status, 'succeeded');
  } finally {
    cleanup();
  }
});

test('concurrent sibling field writes become an explicit resolvable conflict', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    ensureEventLog(db, scopeDir);
    const ticket = createTicket(db, { type: 'story', title: 'Original', actor: 'planner' });
    const dir = eventsDir(scopeDir);
    const base = readAllEvents(dir);
    const baseRevision = revisionForEvents(base);
    appendEvent(dir, makeEvent('ticket.set_field', {
      ticketId: ticket.uid, field: 'title', value: 'Replica A',
    }, { actor: 'agent-a', baseRevision }));
    appendEvent(dir, makeEvent('ticket.set_field', {
      ticketId: ticket.uid, field: 'title', value: 'Replica B',
    }, { actor: 'agent-b', baseRevision }));
    replayInto(db, readAllEvents(dir));
    const conflicts = listConflicts(db);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, 'title');
    resolveConflict(db, conflicts[0].conflictId, { value: 'Chosen', actor: 'reviewer' });
    replayInto(db, readAllEvents(dir));
    assert.equal(getTicket(db, ticket.id).title, 'Chosen');
    assert.equal(listConflicts(db).length, 0);
    assert.equal(listConflicts(db, { unresolvedOnly: false })[0].resolution.value, 'Chosen');
  } finally {
    cleanup();
  }
});

test('slash prose and historical observations never certify complete ownership', () => {
  const { db, cleanup } = createTempScope();
  try {
    const prose = createTicket(db, { type: 'story', title: 'door/obstruction eligibility/interior grants/revocations unregister/rebind AS-174/175 atomic/versioned quit/relaunch' });
    const path = createTicket(db, { type: 'story', title: 'Update src/door.cpp and include/door.h' });
    const historical = createTicket(db, { type: 'story', title: 'Old attempt' });
    const claim = claimTicket(db, historical.id, { agent: 'old', files: ['src/old.cpp'] });
    finishAttempt(db, claim.attempt.attemptId, { outcome: 'failed', agent: 'old' });
    const plan = parallelPlan(db);
    assert.deepEqual(plan.candidates.find((c) => c.ticket.id === prose.id).repositoryIntent.files, []);
    assert.deepEqual(plan.candidates.find((c) => c.ticket.id === path.id).repositoryIntent.files, ['include/door.h', 'src/door.cpp']);
    assert.deepEqual(new Set(plan.unresolvedIntent), new Set([prose.id, path.id, historical.id]));
    assert.ok(plan.parallelGroups.every((group) => !group.safe));
  } finally { cleanup(); }
});

test('declared source paths, shared interfaces and physical generated outputs model ownership', () => {
  const { db, cleanup } = createTempScope();
  try {
    const make = (title, intent) => {
      const ticket = createTicket(db, { type: 'story', title });
      setContract(db, ticket.id, { policy: { repositoryIntent: intent } });
      return ticket;
    };
    const a = make('A', { files: ['./src/./shared.h'], worktree: '/wt/a', outputs: ['build/result'] });
    const b = make('B', { files: ['src/b.cpp'], worktree: '/wt/b', outputs: ['build/result'] });
    const reader = make('Reader', { reads: ['src/shared.h'] });
    const writer = make('Other worktree writer', { files: ['src/shared.h'], worktree: '/wt/c' });
    const output = make('Shared output', { outputs: ['/wt/a/build/result'] });
    const malformed = make('Malformed intent', { files: ['../escape'] });
    const plan = parallelPlan(db);
    const conflict = (x, y) => plan.conflicts.some((c) => c.tickets.includes(x.id) && c.tickets.includes(y.id));
    assert.equal(conflict(a, b), false);
    assert.equal(conflict(a, reader), true);
    assert.equal(conflict(a, writer), true);
    assert.equal(conflict(a, output), true);
    assert.ok(plan.unresolvedIntent.includes(malformed.id));
    assert.ok(plan.parallelGroups.some((g) => g.safe && g.tickets.includes(a.id) && g.tickets.includes(b.id)));
    const active = createTicket(db, { type: 'story', title: 'Unknown active worker' });
    const claim = claimTicket(db, active.id, { agent: 'unknown', ttl: '1s' });
    assert.ok(parallelPlan(db).parallelGroups.every((g) => !g.safe));
    assert.deepEqual(parallelPlan(db).unresolvedActiveIntent, [active.id]);
    const expiredPlan = parallelPlan(db, { now: new Date(Date.parse(claim.lease.expiresAt) + 1) });
    assert.deepEqual(expiredPlan.unresolvedActiveIntent, []);
    assert.ok(expiredPlan.parallelGroups.some((g) => g.safe));
  } finally { cleanup(); }
});

test('exclusive file admission detects normalized directory and descendant overlaps', () => {
  const { db, cleanup } = createTempScope();
  try {
    const a = createTicket(db, { type: 'story', title: 'Directory owner' });
    const b = createTicket(db, { type: 'story', title: 'File owner' });
    setContract(db, b.id, { policy: { exclusiveFiles: true } });
    claimTicket(db, a.id, { agent: 'a', files: ['./src/'] });
    assert.throws(() => claimTicket(db, b.id, { agent: 'b', files: ['src/file.js'] }), (e) => e.code === 'FILE_OVERLAP');
  } finally { cleanup(); }
});

test('cancelling a superseded attempt preserves the current handoff and permits coordinator reclaim', () => {
  const { db, scopeDir, cleanup } = createTempScope();
  try {
    ensureEventLog(db, scopeDir);
    const ticket = createTicket(db, { type: 'story', title: 'AS-201 lifecycle reproduction' });
    const start = Date.parse('2026-09-04T00:00:00Z');
    const old = claimTicket(db, ticket.id, { agent: 'worker', now: new Date(start), ttl: '1s' });
    const current = claimTicket(db, ticket.id, { agent: 'worker', now: new Date(start + 1001) });
    createHandoff(db, ticket.id, { agent: 'worker', attemptId: current.attempt.attemptId,
      summary: 'Implementation ready for coordinator integration', now: new Date(start + 2000) });
    finishAttempt(db, old.attempt.attemptId, { agent: 'worker', outcome: 'cancelled',
      summary: 'Superseded historical attempt', now: new Date(start + 3000) });
    assert.equal(getAttempt(db, old.attempt.attemptId).status, 'cancelled');
    assert.equal(getTicket(db, ticket.id).status, 'todo');
    assert.equal(executionState(db, ticket.id, { now: new Date(start + 3000) }).phase, 'handed_off');
    replayInto(db, readAllEvents(eventsDir(scopeDir)));
    assert.equal(getTicket(db, ticket.id).status, 'todo', 'replay preserves current lifecycle too');
    const coordinator = claimTicket(db, ticket.id, { agent: 'coordinator', now: new Date(start + 4000) });
    assert.equal(coordinator.ticket.status, 'in_progress');
  } finally { cleanup(); }
});

test('historical outcomes cannot move a current running, reviewed, or completed ticket', () => {
  const { db, cleanup } = createTempScope();
  try {
    const start = Date.parse('2026-09-04T00:00:00Z');
    for (const stage of ['running', 'review', 'done']) {
      const ticket = createTicket(db, { type: 'story', title: stage });
      const old = claimTicket(db, ticket.id, { agent: 'old', now: new Date(start), ttl: '1s' });
      const current = claimTicket(db, ticket.id, { agent: 'current', now: new Date(start + 1001) });
      if (stage === 'review') finishAttempt(db, current.attempt.attemptId, { agent: 'current', outcome: 'succeeded', now: new Date(start + 2000) });
      if (stage === 'done') completeWork(db, ticket.id, { agent: 'current', attemptId: current.attempt.attemptId, now: new Date(start + 2000) });
      const status = getTicket(db, ticket.id).status;
      finishAttempt(db, old.attempt.attemptId, { agent: 'old', outcome: stage === 'running' ? 'failed' : 'cancelled', now: new Date(start + 3000) });
      assert.equal(getTicket(db, ticket.id).status, status, stage);
      if (stage === 'running') {
        finishAttempt(db, current.attempt.attemptId, { agent: 'current', outcome: 'cancelled', now: new Date(start + 4000) });
        assert.equal(getTicket(db, ticket.id).status, 'cancelled', 'current owner can still cancel');
      }
    }
  } finally { cleanup(); }
});

test('exclusive claim admission uses declared generated outputs and shared interface reads', () => {
  const { db, cleanup } = createTempScope();
  try {
    const owner = createTicket(db, { type: 'story', title: 'Generated output and interface owner' });
    setContract(db, owner.id, { policy: { repositoryIntent: { files: ['src/shared.h'], outputs: ['Build/result'], worktree: '/work/a' } } });
    claimTicket(db, owner.id, { agent: 'owner', worktree: '/work/a' });
    for (const intent of [{ outputs: ['/work/a/Build/result'] }, { reads: ['src/shared.h'] }]) {
      const contender = createTicket(db, { type: 'story', title: 'Declared contender' });
      setContract(db, contender.id, { policy: { exclusiveFiles: true, repositoryIntent: intent } });
      assert.throws(() => claimTicket(db, contender.id, { agent: 'contender', worktree: '/work/b' }), (error) => error.code === 'FILE_OVERLAP');
    }
    const separate = createTicket(db, { type: 'story', title: 'Independent generated output' });
    setContract(db, separate.id, { policy: { exclusiveFiles: true, repositoryIntent: { outputs: ['Build/result'] } } });
    assert.doesNotThrow(() => claimTicket(db, separate.id, { agent: 'separate', worktree: '/work/b' }));
  } finally { cleanup(); }
});

test('a contender cannot bypass an active owner exclusive intent policy', () => {
  const { db, cleanup } = createTempScope();
  try {
    const owner = createTicket(db, { type: 'story', title: 'Exclusive owner' });
    const contender = createTicket(db, { type: 'story', title: 'Ordinary contender' });
    setContract(db, owner.id, { policy: { files: ['src/shared'], exclusiveFiles: true } });
    claimTicket(db, owner.id, { agent: 'owner' });
    assert.throws(() => claimTicket(db, contender.id, { agent: 'contender', files: ['src/shared/child.cpp'] }), (error) => error.code === 'FILE_OVERLAP');
  } finally { cleanup(); }
});
