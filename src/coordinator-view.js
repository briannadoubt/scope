import { createHash } from 'node:crypto';
import { parallelPlan, readiness } from './agent-runtime.js';
import { ScopeCliError } from './protocol.js';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const SECTIONS = ['conflicts', 'unresolvedIntent', 'unresolvedActiveIntent', 'deferred', 'blockers', 'tickets', 'parallelGroups'];

/** Opt-in, lossless pagination of coordinator signals, without narrative/history payloads. */
export function coordinatorView(db, { budgetBytes = 16384, cursor = null, since = null, ...options } = {}) {
  budgetBytes = Number(budgetBytes);
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 2048 || budgetBytes > 1048576) {
    throw new ScopeCliError('budgetBytes must be an integer between 2048 and 1048576');
  }
  if (cursor && since) throw new ScopeCliError('cursor and since cannot be combined');
  const plan = parallelPlan(db, options);
  const params = options.parentId ? [options.parentId] : [];
  const allTickets = db.prepare(`SELECT id,title,status FROM tickets WHERE type!='epic'
    ${options.parentId ? 'AND parent_id=?' : ''} ORDER BY number,id`).all(...params);
  const candidates = new Map(plan.candidates.map((item) => [item.ticket.id, item]));
  const blockers = [];
  const tickets = allTickets.map((ticket) => {
    const candidate = candidates.get(ticket.id);
    const ready = candidate?.readiness ?? readiness(db, ticket.id, options);
    const execution = ready.execution;
    for (const blocker of ready.blockers) blockers.push({ ticketId: ticket.id, type: 'dependency', id: blocker.id, status: blocker.status });
    for (const [index, body] of (execution.latestHandoff?.data?.blockers ?? []).entries()) {
      blockers.push({ ticketId: ticket.id, type: 'handoff', discoveryId: execution.latestHandoff.discoveryId, index, body });
    }
    if (execution.latestDiscovery?.type === 'blocker') blockers.push({ ticketId: ticket.id,
      type: 'discovery', discoveryId: execution.latestDiscovery.discoveryId, body: execution.latestDiscovery.body });
    return {
      id: ticket.id, title: ticket.title.slice(0, 160), titleAbbreviated: ticket.title.length > 160,
      status: ticket.status, readiness: ready.state, reasons: ready.reasons,
      missingCapabilities: ready.missingCapabilities ?? [],
      execution: { phase: execution.phase, agent: execution.agent,
        attemptId: execution.attempt?.attemptId ?? null, leaseId: execution.lease?.leaseId ?? null,
        leaseState: execution.lease?.state ?? 'none', expiresAt: execution.lease?.expiresAt ?? null,
        handoffId: execution.latestHandoff?.discoveryId ?? null,
        verification: { requiredCount: execution.verification.required.length,
          missingCount: execution.verification.missing.length, evidenceCount: execution.verification.evidenceCount,
          satisfied: execution.verification.satisfied } },
      ...(candidate ? { repositoryIntent: candidate.repositoryIntent } : {}),
    };
  });
  const sections = { ...plan, tickets, blockers };
  const records = SECTIONS.flatMap((section) => sections[section].map((value) => ({ section, value })));
  const snapshot = digest({ capabilities: options.capabilities ?? [], parentId: options.parentId ?? null, records });
  let offset = 0;
  if (cursor) {
    const match = /^([a-f0-9]{64}):(\d+)$/.exec(cursor);
    if (!match) throw new ScopeCliError('invalid coordinator cursor');
    if (match[1] !== snapshot) throw new ScopeCliError('coordinator snapshot changed; restart without cursor', {
      code: 'STALE_CURSOR', retryable: true, details: { snapshot },
    });
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset < 1 || offset >= records.length) throw new ScopeCliError('invalid coordinator cursor offset');
  }
  const response = {
    view: 'coordinator-v1', snapshot, unchanged: since === snapshot,
    totals: Object.fromEntries(SECTIONS.map((section) => [section, sections[section].length])),
    records: [], complete: false, nextCursor: null,
    detail: 'Use ready <ticketId>, context <ticketId> --budget <tokens>, or ready --plan for full detail; use watch --since <eventId> for event updates.',
  };
  if (response.unchanged) return { ...response, complete: true };
  for (let index = offset; index < records.length; index += 1) {
    response.records.push(records[index]);
    response.nextCursor = index + 1 < records.length ? `${snapshot}:${index + 1}` : null;
    response.complete = response.nextCursor === null;
    if (bytes(response) > budgetBytes) {
      response.records.pop();
      response.nextCursor = `${snapshot}:${index}`;
      response.complete = false;
      if (!response.records.length) throw new ScopeCliError('one coordinator record exceeds budget; increase --budget-bytes or inspect full detail', {
        code: 'COORDINATOR_RECORD_TOO_LARGE', details: { section: records[index].section, offset: index,
          requiredBytes: bytes({ ...response, records: [records[index]] }) },
      });
      break;
    }
  }
  if (!records.length) response.complete = true;
  return response;
}
