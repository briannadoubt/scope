import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createTempScope } from './helpers.js';
import { createTicket } from '../src/repo.js';
import { claimTicket, setContract, readiness, renewLease, finishAttempt } from '../src/agent-runtime.js';
import { acquireResources, releaseResources, phaseReadiness } from '../src/agent-resources.js';
import { replayInto } from '../src/replay.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { ensureEventLog } from '../src/backfill.js';

function worker(db, name, { key = 'host:local:engine-build', capacity = 1, units = 1, now = new Date() } = {}) {
  const ticket = createTicket(db, { type: 'story', title: name });
  setContract(db, ticket.id, { policy: { files: [`src/${name}.cpp`], resourceRequirements: {
    build: [{ key, capacity, units }], capture: [{ key: 'host:local:foreground' }],
  } } });
  const claimed = claimTicket(db, ticket.id, { agent: name, now, ttl: '10m' });
  return { ticket, ...claimed, agent: name };
}

test('resource phase waits independently of authoring; release, completion and expiry recover capacity', () => {
  const { db, scopeDir, cleanup } = createTempScope();
  try {
    ensureEventLog(db, scopeDir);
    const now = new Date('2026-09-04T00:00:00Z');
    const a = worker(db, 'a', { now });
    const b = worker(db, 'b', { now });
    acquireResources(db, a.lease.leaseId, { agent: a.agent, phase: 'build', now });
    assert.equal(phaseReadiness(db, b.ticket.id, 'build', { now }).state, 'blocked');
    assert.equal(phaseReadiness(db, b.ticket.id, 'capture', { now }).state, 'available');
    const authoring = createTicket(db, { type: 'story', title: 'Independent authoring' });
    setContract(db, authoring.id, { policy: { resourceRequirements: { build: [{ key: 'host:local:engine-build' }] } } });
    assert.equal(readiness(db, authoring.id, { now }).state, 'ready');
    assert.throws(() => acquireResources(db, b.lease.leaseId, { agent: b.agent, phase: 'build', now }), (e) => e.code === 'RESOURCE_UNAVAILABLE');
    assert.throws(() => acquireResources(db, a.lease.leaseId, { agent: b.agent, phase: 'build', now }), (e) => e.code === 'LEASE_OWNERSHIP');
    acquireResources(db, a.lease.leaseId, { agent: a.agent, phase: 'capture', now });
    releaseResources(db, a.lease.leaseId, { agent: a.agent, phase: 'build', now });
    assert.equal(phaseReadiness(db, b.ticket.id, 'build', { now }).state, 'available');
    assert.equal(phaseReadiness(db, b.ticket.id, 'capture', { now }).state, 'blocked');
    acquireResources(db, b.lease.leaseId, { agent: b.agent, phase: 'build', now });
    replayInto(db, readAllEvents(eventsDir(scopeDir)));
    assert.equal(phaseReadiness(db, a.ticket.id, 'capture', { now }).state, 'held', 'holds survive cache rebuild');
    renewLease(db, a.lease.leaseId, { agent: a.agent, ttl: '20m', now });
    assert.equal(phaseReadiness(db, b.ticket.id, 'capture', { now: new Date(now.getTime() + 11 * 60000) }).state, 'blocked');
    finishAttempt(db, a.attempt.attemptId, { agent: a.agent, outcome: 'succeeded', now });
    assert.equal(phaseReadiness(db, b.ticket.id, 'capture', { now }).state, 'available');
    const expired = new Date(now.getTime() + 11 * 60000);
    assert.equal(phaseReadiness(db, a.ticket.id, 'build', { now: expired }).state, 'available');
    assert.throws(() => acquireResources(db, b.lease.leaseId, { agent: b.agent, phase: 'build', now: expired }), (e) => e.code === 'LEASE_EXPIRED');
  } finally { cleanup(); }
});

test('resource domains and capacities are distinct; multi-resource acquisition is all or nothing', () => {
  const { db, cleanup } = createTempScope();
  try {
    const a = worker(db, 'a', { key: 'host:a:cpu', capacity: 2 });
    const b = worker(db, 'b', { key: 'host:a:cpu', capacity: 2 });
    const c = worker(db, 'c', { key: 'host:a:cpu', capacity: 2 });
    const remote = worker(db, 'remote', { key: 'host:b:cpu', capacity: 2 });
    for (const work of [a, b, remote]) acquireResources(db, work.lease.leaseId, { agent: work.agent, phase: 'build' });
    assert.equal(phaseReadiness(db, c.ticket.id, 'build').state, 'blocked');
    setContract(db, c.ticket.id, { policy: { resourceRequirements: { build: [
      { key: 'host:a:free' }, { key: 'host:a:cpu', capacity: 2 },
    ] } } });
    assert.throws(() => acquireResources(db, c.lease.leaseId, { agent: c.agent, phase: 'build' }), (e) => e.code === 'RESOURCE_UNAVAILABLE');
    assert.equal(JSON.parse(db.prepare('SELECT resources FROM agent_leases WHERE lease_id=?').get(c.lease.leaseId).resources).length, 0);
    const mismatch = worker(db, 'mismatch', { key: 'host:a:cpu', capacity: 3 });
    assert.equal(phaseReadiness(db, mismatch.ticket.id, 'build').blockers[0].reason, 'capacity_mismatch');
  } finally { cleanup(); }
});

test('two independent processes cannot both acquire one resource slot', async () => {
  const { db, scopeDir, cleanup } = createTempScope();
  try {
    ensureEventLog(db, scopeDir);
    const workers = [worker(db, 'process-a'), worker(db, 'process-b')];
    const code = `import { openDb } from ${JSON.stringify(new URL('../src/db.js', import.meta.url).href)};
      import { acquireResources } from ${JSON.stringify(new URL('../src/agent-resources.js', import.meta.url).href)};
      const db = openDb(process.argv[1]);
      try { acquireResources(db, process.argv[2], { agent: process.argv[3], phase: 'build' }); console.log('acquired'); }
      catch (error) { console.log(error.code); }
      finally { db.close(); }`;
    const results = await Promise.all(workers.map((work) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, scopeDir, work.lease.leaseId, work.agent]);
      let output = ''; let error = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { error += data; });
      child.on('error', reject);
      child.on('close', (status) => status === 0 ? resolve(output.trim()) : reject(new Error(error)));
    })));
    assert.deepEqual(results.sort(), ['RESOURCE_UNAVAILABLE', 'acquired']);
    replayInto(db, readAllEvents(eventsDir(scopeDir)));
    assert.equal(workers.filter((work) => phaseReadiness(db, work.ticket.id, 'build').state === 'held').length, 1);
  } finally { cleanup(); }
});

test('resource admission rejects unknown phases, stale handles after reclaim and invalid declarations', () => {
  const { db, cleanup } = createTempScope();
  try {
    const now = new Date('2026-09-04T00:00:00Z');
    const work = worker(db, 'owner', { now });
    assert.throws(() => acquireResources(db, work.lease.leaseId, { agent: work.agent, phase: 'missing', now }), /undeclared/);
    const later = new Date(now.getTime() + 11 * 60000);
    const replacement = claimTicket(db, work.ticket.id, { agent: work.agent, now: later });
    acquireResources(db, replacement.lease.leaseId, { agent: work.agent, phase: 'build', now: later });
    assert.throws(() => releaseResources(db, work.lease.leaseId, { agent: work.agent, phase: 'build', now: later }), (e) => e.code === 'LEASE_EXPIRED');
    assert.equal(phaseReadiness(db, work.ticket.id, 'build', { now: later }).state, 'held');
    setContract(db, work.ticket.id, { policy: { resourceRequirements: { build: [{ key: 'bad', units: 0 }] } } });
    assert.throws(() => phaseReadiness(db, work.ticket.id, 'build', { now: later }), /positive integer/);
  } finally { cleanup(); }
});
