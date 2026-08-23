import { ulid } from './ulid.js';
import { doneColumnIds, normalizeColumns, terminalColumns } from './columns.js';
import {
  emitDomainChange,
  emitDomainEvent,
  getTicket,
  listComments,
  listRelations,
  updateTicket,
  withEventMutation,
} from './repo.js';
import { getWorkspace } from './db.js';
import { ScopeCliError } from './protocol.js';
import { eventsDirForDb, readAllEvents } from './event-store.js';

const DISCOVERY_TYPES = new Set(['decision', 'fact', 'risk', 'blocker', 'question', 'handoff', 'evidence']);
const ATTEMPT_OUTCOMES = new Set(['succeeded', 'failed', 'handed_off', 'cancelled']);

const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};

export function parseDuration(input = '20m') {
  const match = /^(\d+)(s|m|h|d)$/.exec(String(input));
  if (!match) throw new ScopeCliError(`invalid duration ${input}; use 30s, 20m, 2h, or 1d`);
  const scale = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Number(match[1]) * scale;
}

function contractRow(row) {
  if (!row) return null;
  return {
    ticketId: row.ticket_id,
    acceptance: parse(row.acceptance, []),
    constraints: parse(row.constraints, []),
    verificationCommands: parse(row.verification_commands, []),
    requiredCapabilities: parse(row.required_capabilities, []),
    policy: parse(row.policy, {}),
    planVersion: row.plan_version,
    updatedAt: row.updated_at,
  };
}

function leaseRow(row) {
  if (!row) return null;
  return {
    leaseId: row.lease_id, ticketId: row.ticket_id, agent: row.agent,
    capabilities: parse(row.capabilities, []), files: parse(row.files, []),
    worktree: row.worktree, branch: row.branch, baseSha: row.base_sha,
    claimedAt: row.claimed_at, heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at, releasedAt: row.released_at, releaseReason: row.release_reason,
  };
}

function attemptRow(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id, ticketId: row.ticket_id, leaseId: row.lease_id,
    agent: row.agent, status: row.status, startedAt: row.started_at,
    finishedAt: row.finished_at, summary: row.summary, failure: row.failure,
    evidence: parse(row.evidence, []), verification: parse(row.verification, []),
  };
}

function discoveryRow(row) {
  if (!row) return null;
  return {
    discoveryId: row.discovery_id,
    ticketId: row.ticket_id,
    type: row.type,
    body: row.body,
    data: parse(row.data, {}),
    author: row.author,
    createdAt: row.created_at,
  };
}

function latestLease(db, ticketId) {
  return leaseRow(db.prepare('SELECT * FROM agent_leases WHERE ticket_id=? ORDER BY claimed_at DESC LIMIT 1').get(ticketId));
}

function latestAttempt(db, ticketId) {
  return attemptRow(db.prepare('SELECT * FROM agent_attempts WHERE ticket_id=? ORDER BY started_at DESC LIMIT 1').get(ticketId));
}

function latestDiscovery(db, ticketId, type = null) {
  const row = type
    ? db.prepare('SELECT * FROM agent_discoveries WHERE ticket_id=? AND type=? ORDER BY created_at DESC LIMIT 1').get(ticketId, type)
    : db.prepare('SELECT * FROM agent_discoveries WHERE ticket_id=? ORDER BY created_at DESC LIMIT 1').get(ticketId);
  return discoveryRow(row);
}

function columnFor(columns, role) {
  const normalized = normalizeColumns(columns);
  const ids = {
    working: ['in_progress'],
    ready: ['todo'],
    review: ['in_review'],
  }[role] ?? [];
  const labels = {
    working: ['in progress', 'doing', 'active', 'building'],
    ready: ['todo', 'ready'],
    review: ['in review', 'review'],
  }[role] ?? [];
  return normalized.find((column) => ids.includes(column.id))
    ?? normalized.find((column) => labels.includes(column.label.toLowerCase()))
    ?? null;
}

function reconcileTicketStatus(db, ticketId, role, actor, model) {
  const ticket = getTicket(db, ticketId);
  if (!ticket) return null;
  const workspace = getWorkspace(db);
  const target = role === 'cancelled'
    ? normalizeColumns(workspace.columns).find((column) => column.kind === 'cancelled')
    : columnFor(workspace.columns, role);
  if (!target || target.id === ticket.status) return ticket;
  const terminal = new Set([
    ...doneColumnIds(workspace.columns),
    ...terminalColumns(workspace.columns).map((column) => column.id),
  ]);
  if (terminal.has(ticket.status) && role !== 'cancelled') return ticket;
  return updateTicket(db, ticketId, { status: target.id }, actor, model);
}

function verificationState(contract, attempt) {
  const required = contract?.verificationCommands ?? [];
  const results = attempt?.verification ?? [];
  const missing = required.filter((command) => !results.some((item) => item?.command === command && item?.ok === true));
  const evidenceCount = attempt?.evidence?.length ?? 0;
  const policy = contract?.policy ?? {};
  const hasPassingVerification = results.some((item) => item?.ok === true);
  return {
    required,
    results,
    missing,
    evidenceCount,
    satisfied: missing.length === 0
      && (!policy.requireEvidence || evidenceCount > 0)
      && (!policy.requireVerification || hasPassingVerification),
  };
}

/** Machine-oriented execution projection for scheduling, recovery, and review. */
export function executionState(db, ticketId, { now = new Date() } = {}) {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
  const lease = latestLease(db, ticketId);
  const attempt = latestAttempt(db, ticketId);
  const active = lease && !lease.releasedAt && lease.expiresAt > now.toISOString();
  const stale = lease && !lease.releasedAt && lease.expiresAt <= now.toISOString();
  const leaseState = !lease ? 'none' : lease.releasedAt ? 'released' : active ? 'active' : 'expired';
  const phase = active
    ? 'running'
    : stale && attempt?.status === 'running'
      ? 'stale'
      : attempt?.status ?? 'idle';
  const contract = getContract(db, ticketId);
  return {
    phase,
    agent: active ? lease.agent : attempt?.agent ?? lease?.agent ?? null,
    reclaimable: phase === 'stale' || ['failed', 'handed_off', 'cancelled'].includes(phase),
    lease: lease ? { ...lease, state: leaseState } : null,
    attempt,
    files: lease?.files ?? [],
    repository: lease ? { worktree: lease.worktree, branch: lease.branch, baseSha: lease.baseSha } : null,
    latestDiscovery: latestDiscovery(db, ticketId),
    latestHandoff: latestDiscovery(db, ticketId, 'handoff'),
    verification: verificationState(contract, attempt),
  };
}

export function enrichTicketsWithExecution(db, tickets, options = {}) {
  return tickets.map((ticket) => ({ ...ticket, execution: executionState(db, ticket.id, options) }));
}

export function getContract(db, ticketId) {
  return contractRow(db.prepare('SELECT * FROM agent_contracts WHERE ticket_id=?').get(ticketId));
}

export function setContract(db, ticketId, contract, actor = null, model = null) {
  return withEventMutation(db, () => {
    const ticket = getTicket(db, ticketId);
    if (!ticket) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
    const value = {
      acceptance: contract.acceptance ?? [],
      constraints: contract.constraints ?? [],
      verificationCommands: contract.verificationCommands ?? [],
      requiredCapabilities: contract.requiredCapabilities ?? [],
      policy: contract.policy ?? {},
    };
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_contracts
      (ticket_id, acceptance, constraints, verification_commands, required_capabilities, policy, plan_version, updated_at)
      VALUES (?,?,?,?,?,?,0,?)
      ON CONFLICT(ticket_id) DO UPDATE SET acceptance=excluded.acceptance,
        constraints=excluded.constraints, verification_commands=excluded.verification_commands,
        required_capabilities=excluded.required_capabilities, policy=excluded.policy, updated_at=excluded.updated_at`
    ).run(ticket.id, json(value.acceptance), json(value.constraints), json(value.verificationCommands),
      json(value.requiredCapabilities), json(value.policy), now);
    emitDomainEvent(db, 'agent.contract.set', { ticketId: ticket.uid, contract: value }, actor, model);
    emitDomainChange({ type: 'agent.contract.updated', id: ticket.id });
    return getContract(db, ticket.id);
  });
}

export function activeLease(db, ticketId, now = new Date()) {
  return leaseRow(db.prepare(`SELECT * FROM agent_leases WHERE ticket_id=? AND released_at IS NULL
    AND expires_at>? ORDER BY claimed_at DESC LIMIT 1`).get(ticketId, now.toISOString()));
}

export function readiness(db, ticketId, { now = new Date(), capabilities = [] } = {}) {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
  const result = (value) => ({ ...value, execution: executionState(db, ticketId, { now }) });
  const columns = getWorkspace(db).columns;
  const terminal = new Set([...doneColumnIds(columns), ...terminalColumns(columns).map((column) => column.id)]);
  if (terminal.has(ticket.status)) return result({ state: 'terminal', reasons: [`status:${ticket.status}`], blockers: [], lease: null });
  const blockers = db.prepare(`SELECT r.to_ticket_id AS id, t.title, t.status
    FROM ticket_relations r JOIN tickets t ON t.id=r.to_ticket_id
    WHERE r.from_ticket_id=? AND r.type='blocked_by'`).all(ticket.id)
    .filter((row) => !terminal.has(row.status));
  const lease = activeLease(db, ticket.id, now);
  const contract = getContract(db, ticket.id);
  const missingCapabilities = (contract?.requiredCapabilities ?? []).filter((item) => !capabilities.includes(item));
  if (blockers.length) return result({ state: 'blocked', reasons: ['dependencies'], blockers, lease, missingCapabilities });
  if (lease) return result({ state: 'claimed', reasons: [`leased:${lease.agent}`], blockers, lease, missingCapabilities });
  if (missingCapabilities.length) return result({ state: 'ineligible', reasons: ['missing_capabilities'], blockers, lease, missingCapabilities });
  return result({ state: 'ready', reasons: [], blockers, lease: null, missingCapabilities: [] });
}

export function listReady(db, { capabilities = [], now = new Date(), parentId = null } = {}) {
  const params = [];
  let where = `WHERE type!='epic'`;
  if (parentId) { where += ' AND parent_id=?'; params.push(parentId); }
  const tickets = db.prepare(`SELECT * FROM tickets ${where}
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      COALESCE(rank, number), number`).all(...params);
  return tickets.map((ticket) => ({ ticket: { ...ticket, labels: parse(ticket.labels, []) }, readiness: readiness(db, ticket.id, { capabilities, now }) }))
    .filter((item) => item.readiness.state === 'ready');
}

function referencedPaths(ticket) {
  const text = `${ticket.title ?? ''}\n${ticket.description ?? ''}`;
  return Array.from(new Set(text.match(/\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\b/g) ?? [])).sort();
}

function repositoryIntent(db, ticket) {
  const contract = getContract(db, ticket.id);
  const declared = contract?.policy?.files ?? contract?.policy?.repositoryFiles ?? [];
  if (Array.isArray(declared) && declared.length) {
    return { files: Array.from(new Set(declared.map(String))).sort(), source: 'contract', confidence: 'declared' };
  }
  const lease = latestLease(db, ticket.id);
  if (lease?.files?.length) return { files: lease.files, source: 'lease_history', confidence: 'observed' };
  const inferred = referencedPaths(ticket);
  if (inferred.length) return { files: inferred, source: 'ticket_text', confidence: 'inferred' };
  return { files: [], source: 'unknown', confidence: 'unknown' };
}

function overlappingFiles(left, right) {
  const overlap = [];
  for (const a of left) {
    for (const b of right) {
      if (a === b || a.startsWith(`${b.replace(/\/$/, '')}/`) || b.startsWith(`${a.replace(/\/$/, '')}/`)) {
        overlap.push(a === b ? a : `${a} ↔ ${b}`);
      }
    }
  }
  return Array.from(new Set(overlap)).sort();
}

/** Deterministic scheduling advice for a parent using native subagents. */
export function parallelPlan(db, { capabilities = [], now = new Date(), parentId = null } = {}) {
  const candidates = listReady(db, { capabilities, now, parentId }).map((item) => ({
    ...item,
    repositoryIntent: repositoryIntent(db, item.ticket),
  }));
  const active = db.prepare(`SELECT * FROM agent_leases WHERE released_at IS NULL AND expires_at>?
    ORDER BY ticket_id,claimed_at`).all(now.toISOString()).map(leaseRow);
  const conflicts = [];
  const deferred = new Set();

  for (const candidate of candidates) {
    for (const lease of active) {
      const files = overlappingFiles(candidate.repositoryIntent.files, lease.files);
      if (!files.length) continue;
      deferred.add(candidate.ticket.id);
      conflicts.push({
        type: 'active_work_overlap',
        tickets: [candidate.ticket.id, lease.ticketId],
        agent: lease.agent,
        files,
      });
    }
  }

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const files = overlappingFiles(candidates[i].repositoryIntent.files, candidates[j].repositoryIntent.files);
      if (files.length) conflicts.push({
        type: 'candidate_overlap',
        tickets: [candidates[i].ticket.id, candidates[j].ticket.id],
        files,
      });
    }
  }

  const groups = [];
  for (const candidate of candidates.filter((item) => !deferred.has(item.ticket.id))) {
    if (!candidate.repositoryIntent.files.length) {
      groups.push({ tickets: [candidate.ticket.id], safe: false, reason: 'repository_intent_unknown' });
      continue;
    }
    let group = groups.find((item) => item.safe && item.tickets.every((id) => {
      const other = candidates.find((candidateItem) => candidateItem.ticket.id === id);
      return overlappingFiles(candidate.repositoryIntent.files, other.repositoryIntent.files).length === 0;
    }));
    if (!group) {
      group = { tickets: [], safe: true, reason: 'known_disjoint_repository_intent' };
      groups.push(group);
    }
    group.tickets.push(candidate.ticket.id);
  }

  return {
    candidates,
    parallelGroups: groups,
    deferred: candidates.filter((item) => deferred.has(item.ticket.id)).map((item) => item.ticket.id),
    conflicts,
    unresolvedIntent: candidates.filter((item) => !item.repositoryIntent.files.length).map((item) => item.ticket.id),
  };
}

function overlapWarnings(db, files, now) {
  if (!files?.length) return [];
  const wanted = new Set(files);
  return db.prepare(`SELECT * FROM agent_leases WHERE released_at IS NULL AND expires_at>?`).all(now.toISOString())
    .flatMap((row) => {
      const overlap = parse(row.files, []).filter((file) => wanted.has(file));
      return overlap.length ? [{ leaseId: row.lease_id, ticketId: row.ticket_id, agent: row.agent, files: overlap }] : [];
    });
}

export function claimTicket(db, ticketId, options = {}) {
  return withEventMutation(db, () => {
    const now = options.now ?? new Date();
    const agent = String(options.agent || '').trim();
    if (!agent) throw new ScopeCliError('agent is required');
    const ready = readiness(db, ticketId, { now, capabilities: options.capabilities ?? [] });
    if (ready.state !== 'ready') throw new ScopeCliError(`${ticketId} is not ready: ${ready.state}`, {
      code: 'WORK_NOT_READY', retryable: true, details: ready,
    });
    const ttlMs = typeof options.ttlMs === 'number' ? options.ttlMs : parseDuration(options.ttl || '20m');
    const leaseId = ulid(now.getTime());
    const attemptId = ulid(now.getTime());
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const files = options.files ?? [];
    const warnings = overlapWarnings(db, files, now);
    const contract = getContract(db, ticketId);
    if (warnings.length && contract?.policy?.exclusiveFiles) throw new ScopeCliError('file-intent overlaps an active lease', {
      code: 'FILE_OVERLAP', retryable: true, details: warnings,
    });
    db.prepare(`INSERT INTO agent_leases
      (lease_id,ticket_id,agent,capabilities,worktree,branch,base_sha,files,claimed_at,heartbeat_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      leaseId, ticketId, agent, json(options.capabilities ?? []), options.worktree ?? null,
      options.branch ?? null, options.baseSha ?? null, json(files), now.toISOString(), now.toISOString(), expiresAt
    );
    db.prepare(`INSERT INTO agent_attempts
      (attempt_id,ticket_id,lease_id,agent,status,started_at) VALUES (?,?,?,?,?,?)`
    ).run(attemptId, ticketId, leaseId, agent, 'running', now.toISOString());
    const ticket = getTicket(db, ticketId);
    emitDomainEvent(db, 'agent.lease.claim', {
      ticketId: ticket.uid, leaseId, agent, capabilities: options.capabilities ?? [], files,
      worktree: options.worktree ?? null, branch: options.branch ?? null, baseSha: options.baseSha ?? null,
      claimedAt: now.toISOString(), expiresAt,
    }, agent, options.model);
    emitDomainEvent(db, 'agent.attempt.start', {
      attemptId, ticketId: ticket.uid, leaseId, agent, startedAt: now.toISOString(),
    }, agent, options.model);
    const claimedTicket = reconcileTicketStatus(db, ticketId, 'working', agent, options.model);
    emitDomainChange({ type: 'agent.lease.claimed', id: ticketId, leaseId, agent });
    return { ticket: claimedTicket, lease: activeLease(db, ticketId, now), attempt: getAttempt(db, attemptId), warnings };
  });
}

export function claimNext(db, options = {}) {
  return withEventMutation(db, () => {
    const next = listReady(db, options)[0];
    if (!next) throw new ScopeCliError('no eligible ready work', { code: 'NO_READY_WORK', retryable: true });
    return { ticket: next.ticket, ...claimTicket(db, next.ticket.id, options) };
  });
}

export function renewLease(db, leaseId, options = {}) {
  return withEventMutation(db, () => {
    const { agent, ttl = '20m', now = new Date(), model = null } = options;
    const row = db.prepare('SELECT * FROM agent_leases WHERE lease_id=?').get(leaseId);
    if (!row) throw new ScopeCliError(`Lease not found: ${leaseId}`, { code: 'NOT_FOUND' });
    if (row.released_at) throw new ScopeCliError('lease is already released', { code: 'LEASE_RELEASED' });
    if (row.expires_at <= now.toISOString()) throw new ScopeCliError('lease has expired and must be claimed again', {
      code: 'LEASE_EXPIRED', retryable: true,
    });
    if (agent && row.agent !== agent) throw new ScopeCliError('lease belongs to another agent', { code: 'LEASE_OWNERSHIP' });
    const expiresAt = new Date(now.getTime() + parseDuration(ttl)).toISOString();
    const files = Array.from(new Set([...parse(row.files, []), ...(options.files ?? [])])).sort();
    const worktree = options.worktree ?? row.worktree;
    const branch = options.branch ?? row.branch;
    const baseSha = options.baseSha ?? row.base_sha;
    db.prepare(`UPDATE agent_leases SET heartbeat_at=?, expires_at=?, files=?, worktree=?, branch=?, base_sha=?
      WHERE lease_id=?`).run(now.toISOString(), expiresAt, json(files), worktree, branch, baseSha, leaseId);
    emitDomainEvent(db, 'agent.lease.renew', {
      leaseId, heartbeatAt: now.toISOString(), expiresAt, files, worktree, branch, baseSha,
    }, agent || row.agent, model);
    emitDomainChange({ type: 'agent.lease.renewed', id: row.ticket_id, leaseId });
    return leaseRow(db.prepare('SELECT * FROM agent_leases WHERE lease_id=?').get(leaseId));
  });
}

export function releaseLease(db, leaseId, { agent, reason = 'released', now = new Date(), model = null } = {}) {
  return withEventMutation(db, () => {
    const row = db.prepare('SELECT * FROM agent_leases WHERE lease_id=?').get(leaseId);
    if (!row) throw new ScopeCliError(`Lease not found: ${leaseId}`, { code: 'NOT_FOUND' });
    if (agent && row.agent !== agent) throw new ScopeCliError('lease belongs to another agent', { code: 'LEASE_OWNERSHIP' });
    if (!row.released_at) db.prepare('UPDATE agent_leases SET released_at=?, release_reason=? WHERE lease_id=?')
      .run(now.toISOString(), reason, leaseId);
    emitDomainEvent(db, 'agent.lease.release', { leaseId, releasedAt: now.toISOString(), reason }, agent || row.agent, model);
    emitDomainChange({ type: 'agent.lease.released', id: row.ticket_id, leaseId, reason });
    return leaseRow(db.prepare('SELECT * FROM agent_leases WHERE lease_id=?').get(leaseId));
  });
}

export function getAttempt(db, attemptId) {
  return attemptRow(db.prepare('SELECT * FROM agent_attempts WHERE attempt_id=?').get(attemptId));
}

export function finishAttempt(db, attemptId, options = {}) {
  return withEventMutation(db, () => {
    const attempt = getAttempt(db, attemptId);
    if (!attempt) throw new ScopeCliError(`Attempt not found: ${attemptId}`, { code: 'NOT_FOUND' });
    if (attempt.status !== 'running') throw new ScopeCliError(`attempt is already ${attempt.status}`, {
      code: 'ATTEMPT_FINISHED', details: { attemptId, status: attempt.status },
    });
    if (options.agent && attempt.agent !== options.agent) throw new ScopeCliError('attempt belongs to another agent', {
      code: 'ATTEMPT_OWNERSHIP', details: { expected: attempt.agent, actual: options.agent },
    });
    const outcome = options.outcome ?? 'succeeded';
    if (!ATTEMPT_OUTCOMES.has(outcome)) throw new ScopeCliError(`invalid attempt outcome ${outcome}`);
    const now = options.now ?? new Date();
    db.prepare(`UPDATE agent_attempts SET status=?,finished_at=?,summary=?,failure=?,evidence=?,verification=? WHERE attempt_id=?`)
      .run(outcome, now.toISOString(), options.summary ?? null, options.failure ?? null,
        json(options.evidence ?? []), json(options.verification ?? []), attemptId);
    emitDomainEvent(db, 'agent.attempt.finish', {
      attemptId, outcome, finishedAt: now.toISOString(), summary: options.summary ?? null,
      failure: options.failure ?? null, evidence: options.evidence ?? [], verification: options.verification ?? [],
    }, options.agent || attempt.agent, options.model);
    if (attempt.leaseId) releaseLease(db, attempt.leaseId, {
      agent: options.agent || attempt.agent, reason: outcome, now, model: options.model,
    });
    if (options.reconcileStatus !== false) {
      const role = outcome === 'succeeded' ? 'review'
        : outcome === 'cancelled' ? 'cancelled'
          : 'ready';
      reconcileTicketStatus(db, attempt.ticketId, role, options.agent || attempt.agent, options.model);
    }
    emitDomainChange({ type: 'agent.attempt.finished', id: attempt.ticketId, attemptId, outcome });
    return getAttempt(db, attemptId);
  });
}

export function completeWork(db, ticketId, options = {}) {
  return withEventMutation(db, () => {
    const contract = getContract(db, ticketId);
    const policy = contract?.policy ?? {};
    const evidence = options.evidence ?? [];
    const verification = options.verification ?? [];
    const attempt = getAttempt(db, options.attemptId);
    if (!attempt) throw new ScopeCliError(`Attempt not found: ${options.attemptId}`, { code: 'NOT_FOUND' });
    if (attempt.ticketId !== ticketId) throw new ScopeCliError('attempt belongs to a different ticket', {
      code: 'ATTEMPT_TICKET_MISMATCH', details: { expected: ticketId, actual: attempt.ticketId },
    });
    if (attempt.status !== 'running') throw new ScopeCliError(`attempt is already ${attempt.status}`, {
      code: 'ATTEMPT_FINISHED', details: { attemptId: attempt.attemptId, status: attempt.status },
    });
    if (options.agent && attempt.agent !== options.agent) throw new ScopeCliError('attempt belongs to another agent', {
      code: 'ATTEMPT_OWNERSHIP', details: { expected: attempt.agent, actual: options.agent },
    });
    const lease = activeLease(db, ticketId, options.now ?? new Date());
    if (!lease || lease.leaseId !== attempt.leaseId) throw new ScopeCliError('the attempt no longer owns an active lease', {
      code: 'LEASE_EXPIRED', retryable: true, details: { attemptId: attempt.attemptId, leaseId: attempt.leaseId },
    });
    if (policy.requireEvidence && !evidence.length) throw new ScopeCliError('completion requires evidence', { code: 'POLICY_VIOLATION' });
    if (policy.requireVerification && !verification.some((item) => item.ok === true))
      throw new ScopeCliError('completion requires passing verification', { code: 'POLICY_VIOLATION' });
    const missingVerification = (contract?.verificationCommands ?? []).filter((command) =>
      !verification.some((item) => item?.command === command && item?.ok === true));
    if (missingVerification.length) throw new ScopeCliError('completion is missing required passing verification commands', {
      code: 'POLICY_VIOLATION', details: { missingVerification },
    });
    const finishedAttempt = finishAttempt(db, options.attemptId, {
      ...options, outcome: 'succeeded', evidence, verification, reconcileStatus: false,
    });
    const columns = getWorkspace(db).columns;
    const done = doneColumnIds(columns)[0];
    if (!done) throw new ScopeCliError('workspace has no done column', { code: 'POLICY_VIOLATION' });
    const fields = { status: done };
    if (options.branch !== undefined) fields.branch = options.branch;
    if (options.prUrl !== undefined) fields.pr_url = options.prUrl;
    const ticket = updateTicket(db, ticketId, fields, options.agent, options.model);
    return { ticket, attempt: finishedAttempt, receipt: { completedAt: new Date().toISOString(), evidence, verification } };
  });
}

export function addDiscovery(db, ticketId, { type, body, data = {}, author = null, model = null } = {}) {
  return withEventMutation(db, () => {
    if (!DISCOVERY_TYPES.has(type)) throw new ScopeCliError(`invalid discovery type ${type}`);
    const ticket = getTicket(db, ticketId);
    if (!ticket) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
    const discoveryId = ulid();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_discoveries
      (discovery_id,ticket_id,type,body,data,author,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(discoveryId, ticketId, type, body ?? '', json(data), author, now);
    emitDomainEvent(db, 'agent.discovery.add', {
      discoveryId, ticketId: ticket.uid, discoveryType: type, body: body ?? '', data, author, createdAt: now,
    }, author, model);
    emitDomainChange({ type: 'agent.discovery.added', id: ticketId, discoveryId, discoveryType: type });
    return { discoveryId, ticketId, type, body, data, author, createdAt: now };
  });
}

function recentDiscoveryBodies(db, ticketId, type, limit = 20) {
  return db.prepare(`SELECT body FROM agent_discoveries WHERE ticket_id=? AND type=?
    ORDER BY created_at DESC LIMIT ?`).all(ticketId, type, limit).map((row) => row.body).reverse();
}

function arrayOption(value, name) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new ScopeCliError(`${name} must be a JSON array`);
  return value;
}

/** Record a durable cross-session/cross-harness continuation point. */
export function createHandoff(db, ticketId, options = {}) {
  return withEventMutation(db, () => {
    const ticket = getTicket(db, ticketId);
    if (!ticket) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
    const summary = String(options.summary ?? '').trim();
    if (!summary) throw new ScopeCliError('handoff summary is required');
    const attempt = options.attemptId ? getAttempt(db, options.attemptId) : latestAttempt(db, ticketId);
    if (attempt && attempt.ticketId !== ticketId) throw new ScopeCliError('attempt belongs to a different ticket', {
      code: 'ATTEMPT_TICKET_MISMATCH', details: { expected: ticketId, actual: attempt.ticketId },
    });
    if (attempt && options.agent && attempt.agent !== options.agent) throw new ScopeCliError('attempt belongs to another agent', {
      code: 'ATTEMPT_OWNERSHIP', details: { expected: attempt.agent, actual: options.agent },
    });
    const shouldFinish = options.finishAttempt === undefined ? attempt?.status === 'running' : options.finishAttempt;
    const lease = attempt?.leaseId
      ? leaseRow(db.prepare('SELECT * FROM agent_leases WHERE lease_id=?').get(attempt.leaseId))
      : latestLease(db, ticketId);
    if (attempt && shouldFinish) {
      const active = activeLease(db, ticketId, options.now ?? new Date());
      if (attempt.status !== 'running' || !active || active.leaseId !== attempt.leaseId) {
        throw new ScopeCliError('handoff can only finish the currently leased running attempt', {
          code: 'LEASE_EXPIRED', retryable: true, details: { attemptId: attempt.attemptId, leaseId: attempt.leaseId },
        });
      }
    }
    const decisions = arrayOption(options.decisions, 'decisions') ?? recentDiscoveryBodies(db, ticketId, 'decision');
    const blockers = arrayOption(options.blockers, 'blockers') ?? recentDiscoveryBodies(db, ticketId, 'blocker');
    const remaining = arrayOption(options.remaining, 'remaining') ?? [];
    const files = arrayOption(options.files, 'files') ?? lease?.files ?? [];
    const verification = arrayOption(options.verification, 'verification') ?? attempt?.verification ?? [];
    const evidence = arrayOption(options.evidence, 'evidence') ?? attempt?.evidence ?? [];
    const author = options.agent ?? attempt?.agent ?? null;
    const data = {
      handoffVersion: '1.0',
      fromAgent: author,
      toAgent: options.toAgent ?? null,
      sourceAttemptId: attempt?.attemptId ?? null,
      summary,
      decisions,
      files: Array.from(new Set(files.map(String))).sort(),
      verification,
      evidence,
      remaining,
      blockers,
    };
    const handoff = addDiscovery(db, ticketId, {
      type: 'handoff', body: summary, data, author, model: options.model,
    });
    const finishedAttempt = attempt && shouldFinish
      ? finishAttempt(db, attempt.attemptId, {
          outcome: 'handed_off', agent: author, summary, evidence, verification,
          now: options.now, model: options.model,
        })
      : attempt;
    return { handoff, data, attempt: finishedAttempt, execution: executionState(db, ticketId, { now: options.now }) };
  });
}

export function getLatestHandoff(db, ticketId) {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
  return latestDiscovery(db, ticketId, 'handoff');
}

export function revisePlan(db, ticketId, { body, reason = null, actor = null, model = null } = {}) {
  return withEventMutation(db, () => {
    const ticket = getTicket(db, ticketId);
    if (!ticket) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
    const version = (db.prepare('SELECT max(version) AS v FROM agent_plans WHERE ticket_id=?').get(ticketId).v || 0) + 1;
    const now = new Date().toISOString();
    db.prepare('INSERT INTO agent_plans (ticket_id,version,body,reason,actor,created_at) VALUES (?,?,?,?,?,?)')
      .run(ticketId, version, body ?? '', reason, actor, now);
    db.prepare(`INSERT INTO agent_contracts (ticket_id,updated_at,plan_version) VALUES (?,?,?)
      ON CONFLICT(ticket_id) DO UPDATE SET plan_version=excluded.plan_version,updated_at=excluded.updated_at`)
      .run(ticketId, now, version);
    emitDomainEvent(db, 'agent.plan.revise', { ticketId: ticket.uid, version, body: body ?? '', reason, createdAt: now }, actor, model);
    emitDomainChange({ type: 'agent.plan.revised', id: ticketId, version });
    return { ticketId, version, body, reason, actor, createdAt: now };
  });
}

export function contextPack(db, ticketId, { since = null, budget = 4000 } = {}) {
  const ticket = getTicket(db, ticketId);
  if (!ticket) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
  const events = readAllEvents(eventsDirForDb(db));
  const sinceIndex = since ? events.findIndex((event) => event.id === since) : -1;
  if (since && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(since) && sinceIndex < 0) {
    throw new ScopeCliError(`context cursor not found: ${since}`, {
      code: 'CURSOR_NOT_FOUND', retryable: true,
    });
  }
  const sinceTimestamp = sinceIndex >= 0 ? events[sinceIndex].ts : since;
  const touchesTicket = (event) => {
    const payload = event.payload ?? {};
    return payload.ticketId === ticket.uid || payload.fromId === ticket.uid || payload.toId === ticket.uid;
  };
  const changes = events.slice(sinceIndex >= 0 ? sinceIndex + 1 : 0)
    .filter(touchesTicket)
    .map((event) => ({ id: event.id, ts: event.ts, hlc: event.hlc ?? null, kind: event.kind, actor: event.actor, payload: event.payload }));
  const discoveries = db.prepare(`SELECT * FROM agent_discoveries WHERE ticket_id=?
    AND (? IS NULL OR created_at>?) ORDER BY created_at`).all(ticketId, sinceTimestamp, sinceTimestamp).map((row) => ({
      discoveryId: row.discovery_id, type: row.type, body: row.body, data: parse(row.data, {}), author: row.author, createdAt: row.created_at,
    }));
  const attempts = db.prepare('SELECT * FROM agent_attempts WHERE ticket_id=? ORDER BY started_at DESC LIMIT 10')
    .all(ticketId).map(attemptRow);
  const plans = db.prepare('SELECT version,body,reason,actor,created_at AS createdAt FROM agent_plans WHERE ticket_id=? ORDER BY version DESC LIMIT 5').all(ticketId);
  const pack = {
    ticket, contract: getContract(db, ticketId), readiness: readiness(db, ticketId),
    lease: activeLease(db, ticketId), relations: listRelations(db, ticketId), comments: listComments(db, ticketId),
    execution: executionState(db, ticketId), handoff: latestDiscovery(db, ticketId, 'handoff'),
    discoveries, attempts, plans, changes,
  };
  const serialized = JSON.stringify(pack);
  const maxChars = Math.max(1000, Number(budget) * 4);
  const cursor = events.at(-1)?.id ?? since ?? null;
  if (serialized.length <= maxChars) return { ...pack, truncated: false, cursor };
  return {
    ...pack, comments: pack.comments.slice(-3), discoveries: discoveries.slice(-8), attempts: attempts.slice(0, 3), plans: plans.slice(0, 2),
    changes: changes.slice(-12),
    truncated: true, cursor, approximateTokens: Math.ceil(serialized.length / 4),
  };
}

export function agentMetrics(db, now = new Date()) {
  const attempts = db.prepare(`SELECT status,count(*) AS n FROM agent_attempts GROUP BY status`).all();
  const expiredLeases = db.prepare(`SELECT count(*) AS n FROM agent_leases WHERE released_at IS NULL AND expires_at<=?`).get(now.toISOString()).n;
  const activeLeases = db.prepare(`SELECT count(*) AS n FROM agent_leases WHERE released_at IS NULL AND expires_at>?`).get(now.toISOString()).n;
  const repeatedFailures = db.prepare(`SELECT ticket_id,count(*) AS failures FROM agent_attempts
    WHERE status='failed' GROUP BY ticket_id HAVING count(*)>1 ORDER BY failures DESC`).all();
  return { attempts: Object.fromEntries(attempts.map((row) => [row.status, row.n])), activeLeases, expiredLeases, repeatedFailures };
}

export function listConflicts(db, { ticketId = null, unresolvedOnly = true } = {}) {
  const where = [];
  const params = [];
  if (ticketId) { where.push('ticket_id=?'); params.push(ticketId); }
  if (unresolvedOnly) where.push('resolved_at IS NULL');
  return db.prepare(`SELECT * FROM agent_conflicts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY detected_at,conflict_id`).all(...params).map((row) => ({
      conflictId: row.conflict_id, ticketId: row.ticket_id, field: row.field,
      baseRevision: row.base_revision, eventIds: parse(row.event_ids, []), values: parse(row.values_json, []),
      detectedAt: row.detected_at, resolvedAt: row.resolved_at, resolution: parse(row.resolution, null),
    }));
}

export function resolveConflict(db, conflictId, { value, actor = null, model = null } = {}) {
  return withEventMutation(db, () => {
    const conflict = listConflicts(db, { unresolvedOnly: false }).find((item) => item.conflictId === conflictId);
    if (!conflict) throw new ScopeCliError(`Conflict not found: ${conflictId}`, { code: 'NOT_FOUND' });
    const dbField = { parentId: 'parent_id', prUrl: 'pr_url' }[conflict.field] ?? conflict.field;
    const ticket = updateTicket(db, conflict.ticketId, { [dbField]: value }, actor, model);
    const resolvedAt = new Date().toISOString();
    const resolution = { value, actor };
    db.prepare('UPDATE agent_conflicts SET resolved_at=?,resolution=? WHERE conflict_id=?')
      .run(resolvedAt,json(resolution),conflictId);
    emitDomainEvent(db, 'agent.conflict.resolve', {
      conflictId, ticketId: ticket.uid, field: conflict.field, resolution, resolvedAt,
    }, actor, model);
    emitDomainChange({ type: 'agent.conflict.resolved', id: conflict.ticketId, conflictId });
    return { ...conflict, resolvedAt, resolution, ticket };
  });
}

export { DISCOVERY_TYPES, ATTEMPT_OUTCOMES };
