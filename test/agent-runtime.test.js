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
