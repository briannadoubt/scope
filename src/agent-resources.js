import { activeLease, getContract } from './agent-runtime.js';
import { emitDomainChange, emitDomainEvent, getTicket, withEventMutation } from './repo.js';
import { ScopeCliError } from './protocol.js';

function allocations(value) {
  try { return JSON.parse(value ?? '[]'); } catch { return []; }
}

export function resourceRequirements(db, ticketId) {
  const phases = getContract(db, ticketId)?.policy?.resourceRequirements ?? {};
  if (!phases || Array.isArray(phases) || typeof phases !== 'object') throw new ScopeCliError('resourceRequirements must be an object of phase arrays');
  const result = {};
  for (const [phase, requirements] of Object.entries(phases).sort(([a], [b]) => a.localeCompare(b))) {
    if (!phase.trim() || !Array.isArray(requirements)) throw new ScopeCliError('each resource phase must be a named array');
    const seen = new Set();
    result[phase] = requirements.map((item) => {
      const key = item?.key;
      const units = item?.units ?? 1;
      const capacity = item?.capacity ?? 1;
      if (typeof key !== 'string' || !key.trim() || key !== key.trim() || seen.has(key)
        || !Number.isSafeInteger(units) || units < 1 || !Number.isSafeInteger(capacity) || capacity < units) {
        throw new ScopeCliError('resources require unique keys, positive integer units, and capacity >= units');
      }
      seen.add(key);
      return { key, units, capacity, phase };
    }).sort((a, b) => a.key.localeCompare(b.key));
  }
  return result;
}

function activeAllocations(db, now) {
  return db.prepare(`SELECT lease_id,ticket_id,agent,resources,expires_at FROM agent_leases
    WHERE released_at IS NULL AND expires_at>? ORDER BY lease_id`).all(now.toISOString())
    .flatMap((lease) => allocations(lease.resources).map((resource) => ({ ...resource,
      leaseId: lease.lease_id, ticketId: lease.ticket_id, agent: lease.agent, expiresAt: lease.expires_at })));
}

/** Phase admission is independent from authoring/file readiness and never starts a worker. */
export function phaseReadiness(db, ticketId, phase, { now = new Date() } = {}) {
  if (!getTicket(db, ticketId)) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
  const requirements = resourceRequirements(db, ticketId)[phase];
  if (!requirements) throw new ScopeCliError(`resource phase is undeclared: ${phase}`);
  const lease = activeLease(db, ticketId, now);
  const active = activeAllocations(db, now);
  const blockers = [];
  for (const required of requirements) {
    const others = active.filter((item) => item.key === required.key
      && !(item.leaseId === lease?.leaseId && item.phase === phase));
    const used = others.reduce((sum, item) => sum + item.units, 0);
    const mismatch = others.some((item) => item.capacity !== required.capacity);
    if (mismatch || used + required.units > required.capacity) blockers.push({
      key: required.key, reason: mismatch ? 'capacity_mismatch' : 'capacity_exhausted',
      capacity: required.capacity, requested: required.units, used,
      holders: others.map(({ leaseId, ticketId, agent, phase, units, expiresAt }) => ({ leaseId, ticketId, agent, phase, units, expiresAt })),
    });
  }
  const held = lease?.resources?.filter((item) => item.phase === phase) ?? [];
  const matches = JSON.stringify(held) === JSON.stringify(requirements);
  return { ticketId, phase, state: blockers.length ? 'blocked' : lease && matches ? 'held' : 'available',
    leaseId: lease?.leaseId ?? null, requirements, blockers };
}

function ownedLease(db, leaseId, agent, now) {
  const lease = db.prepare('SELECT * FROM agent_leases WHERE lease_id=?').get(leaseId);
  if (!lease) throw new ScopeCliError(`Lease not found: ${leaseId}`, { code: 'NOT_FOUND' });
  if (!agent || lease.agent !== agent) throw new ScopeCliError('resource operation requires the owning agent', { code: 'LEASE_OWNERSHIP' });
  if (lease.released_at || lease.expires_at <= now.toISOString()) throw new ScopeCliError('resource operation requires an active lease; re-read execution state', {
    code: 'LEASE_EXPIRED', retryable: true, details: { leaseId, ticketId: lease.ticket_id },
  });
  return lease;
}

function writeAllocations(db, lease, resources, agent, model) {
  db.prepare('UPDATE agent_leases SET resources=? WHERE lease_id=?').run(JSON.stringify(resources), lease.lease_id);
  emitDomainEvent(db, 'agent.resources.set', { leaseId: lease.lease_id, resources }, agent, model);
  emitDomainChange({ type: 'agent.resources.updated', id: lease.ticket_id, leaseId: lease.lease_id });
  return { leaseId: lease.lease_id, ticketId: lease.ticket_id, resources, expiresAt: lease.expires_at };
}

export function acquireResources(db, leaseId, { agent, phase, now = new Date(), model = null } = {}) {
  return withEventMutation(db, () => {
    // Lock before reading capacity, including when no optimistic revision was supplied.
    db.prepare("UPDATE meta SET value=value WHERE key='schema_version'").run();
    const lease = ownedLease(db, leaseId, agent, now);
    const admission = phaseReadiness(db, lease.ticket_id, phase, { now });
    if (admission.leaseId !== leaseId) throw new ScopeCliError('lease no longer owns this ticket', { code: 'LEASE_EXPIRED', retryable: true });
    if (admission.state === 'blocked') throw new ScopeCliError('execution phase resources are unavailable', {
      code: 'RESOURCE_UNAVAILABLE', retryable: true, details: admission,
    });
    const resources = [...allocations(lease.resources).filter((item) => item.phase !== phase), ...admission.requirements]
      .sort((a, b) => a.phase.localeCompare(b.phase) || a.key.localeCompare(b.key));
    return writeAllocations(db, lease, resources, agent, model);
  });
}

export function releaseResources(db, leaseId, { agent, phase, now = new Date(), model = null } = {}) {
  return withEventMutation(db, () => {
    db.prepare("UPDATE meta SET value=value WHERE key='schema_version'").run();
    const lease = ownedLease(db, leaseId, agent, now);
    if (typeof phase !== 'string' || !phase.trim()) throw new ScopeCliError('phase is required');
    return writeAllocations(db, lease, allocations(lease.resources).filter((item) => item.phase !== phase), agent, model);
  });
}
