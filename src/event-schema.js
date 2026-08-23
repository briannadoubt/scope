/**
 * Event log format — the executable form of docs/event-log-format.md (SCP-107).
 *
 * This module defines Scope's append-only operation log: the envelope, the
 * closed set of event kinds, a dependency-free ULID generator, a builder that
 * produces validated events, a validator that rejects anything the spec
 * forbids, and the canonical total order used by replay (SCP-109) and conflict
 * resolution (SCP-110).
 *
 * Enum values are imported from enums.js — the same lists repo.js feeds into
 * the SQLite CHECK constraints — so the event format and the DB can never drift
 * apart.
 */

import { ulid } from './ulid.js';
import {
  STATUSES as SCHEMA_STATUSES,
  PRIORITIES as SCHEMA_PRIORITIES,
  TICKET_TYPES as SCHEMA_TICKET_TYPES,
  RELATION_TYPES as SCHEMA_RELATION_TYPES,
  TICKET_FIELDS,
} from './enums.js';
import { normalizeColumns } from './columns.js';

export { ulid, TICKET_FIELDS };

/**
 * Event-envelope compatibility contract.
 *
 * Version 1 is the released legacy format. Version 2 makes the expanded
 * transaction/agent vocabulary an explicit reader boundary: current builds
 * continue to read immutable v1 history, but all new events are written as v2
 * so an older binary fails with an upgrade error before attempting replay.
 */
export const EVENT_FORMAT_VERSION = 2;
export const SUPPORTED_EVENT_FORMAT_VERSIONS = Object.freeze([1, EVENT_FORMAT_VERSION]);
export const MINIMUM_READER_EVENT_FORMAT_VERSION = EVENT_FORMAT_VERSION;

/** HTML artifacts are stored inline in events so normal sync remains complete. */
export const ARTIFACT_MAX_BYTES = 512 * 1024;

/** The closed set of legal `kind` values. */
export const EVENT_KINDS = Object.freeze([
  'transaction.commit',
  'workspace.init',
  'workspace.set',
  'workspace.rekey',
  'ticket.create',
  'ticket.set_field',
  'ticket.delete',
  'comment.add',
  'artifact.put',
  'artifact.remove',
  'relation.add',
  'relation.remove',
  'agent.contract.set',
  'agent.lease.claim',
  'agent.lease.renew',
  'agent.lease.release',
  'agent.attempt.start',
  'agent.attempt.finish',
  'agent.discovery.add',
  'agent.plan.revise',
  'agent.conflict.resolve',
  'agent.register',
  'agent.heartbeat',
  'agent.message.send',
  'agent.message.ack',
]);

/* --------------------------- builder --------------------------- */

/**
 * Build a validated event envelope.
 *
 * @param {string} kind - one of EVENT_KINDS
 * @param {object} payload - kind-specific payload (see docs/event-log-format.md)
 * @param {object} opts
 * @param {string} opts.actor - required; the human principal who caused the change
 * @param {string} [opts.model] - optional; the acting model (e.g. "Opus 4.8") when
 *   a coding agent performed the change on the principal's behalf (SCP-128).
 *   Attribution renders as "{model} on behalf of {actor}". Absent for direct
 *   human edits, so old events stay byte-identical.
 * @param {string} [opts.ts] - ISO timestamp; defaults to now
 * @param {number} [opts.ms] - epoch ms for the ULID; defaults to Date.parse(ts) or now
 * @returns {object} the event
 */
let lastHlcMs = 0;
let lastHlcCounter = 0;

function nextHlc(ms) {
  // Preserve wall-clock ordering for explicit imports/backfills; the logical
  // component orders events produced in the same millisecond.
  if (ms === lastHlcMs) lastHlcCounter += 1;
  else { lastHlcMs = ms; lastHlcCounter = 0; }
  return `${String(lastHlcMs).padStart(13, '0')}-${String(lastHlcCounter).padStart(6, '0')}`;
}

export function makeEvent(kind, payload, {
  actor, model, ts, ms, transactionId, transactionIndex, baseRevision, hlc,
  requestId, requestCommand,
} = {}) {
  const when = ts || new Date().toISOString();
  const millis = Number.isFinite(ms) ? ms : Date.parse(when);
  const evt = {
    v: EVENT_FORMAT_VERSION,
    id: ulid(Number.isFinite(millis) ? millis : undefined),
    ts: when,
    actor,
    kind,
    payload,
  };
  evt.hlc = hlc || nextHlc(Number.isFinite(millis) ? millis : Date.now());
  if (baseRevision) evt.baseRevision = baseRevision;
  if (requestId) {
    evt.requestId = requestId;
    evt.requestCommand = requestCommand;
  }
  // Additive optional field: present only when an agent acted on a human's
  // behalf. Omitted otherwise so direct human edits serialize exactly as before.
  if (model) evt.model = model;
  if (transactionId !== undefined) {
    evt.transactionId = transactionId;
    evt.transactionIndex = transactionIndex;
  }
  validateEvent(evt);
  return evt;
}

/**
 * Render an event's actor for display: "{model} on behalf of {actor}" when an
 * agent acted on the principal's behalf (SCP-128), else just the principal.
 * The principal is always the authenticated/named human; the model is metadata.
 */
export function formatActor(actor, model) {
  return model ? `${model} on behalf of ${actor}` : actor;
}

/* -------------------------- validation -------------------------- */

class EventValidationError extends Error {}

class UnsupportedEventVersionError extends EventValidationError {
  constructor(version) {
    const supported = SUPPORTED_EVENT_FORMAT_VERSIONS.join(', ');
    super(
      `Unsupported event format version ${JSON.stringify(version)}. ` +
      `This Scope build reads versions ${supported} and writes version ${EVENT_FORMAT_VERSION}. ` +
      'Upgrade Scope before opening or syncing this workspace.'
    );
    this.name = 'UnsupportedEventVersionError';
    this.code = 'UNSUPPORTED_EVENT_FORMAT';
    this.version = version;
    this.supportedVersions = [...SUPPORTED_EVENT_FORMAT_VERSIONS];
    this.writerVersion = EVENT_FORMAT_VERSION;
  }
}

function fail(msg) {
  throw new EventValidationError(`Invalid event: ${msg}`);
}

const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
// A canonical ULID: 26 Crockford-base32 chars (see src/ulid.js CROCKFORD).
// Enforced on evt.id because the id is used verbatim as an on-disk filename
// (src/event-store.js appendEvent) — an unvalidated id is a path-traversal /
// arbitrary-file-write vector once tenant-supplied events reach the hub FS
// (SCP-196). Keep in sync with the ULID alphabet.
const isUlid = (v) => typeof v === 'string' && /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/.test(v);
const isNullableStr = (v) => v === null || typeof v === 'string';
const isAgentId = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,127}$/.test(v);
const isIso = (v) => isNonEmptyStr(v) && !Number.isNaN(Date.parse(v));
// Same shape updateWorkspace enforces for a workspace key.
const isKeyPrefix = (v) => typeof v === 'string' && /^[A-Z][A-Z0-9]{1,9}$/.test(v);
const isStatusId = (v) => typeof v === 'string' && /^[a-z][a-z0-9_]{1,31}$/.test(v);

/**
 * Throw EventValidationError if `evt` violates the spec. Used by the writer
 * (reject bad writes, SCP-108) and the reader (reject corrupt files, SCP-109).
 */
export function validateEvent(evt) {
  if (!evt || typeof evt !== 'object') fail('not an object');
  if (!Number.isInteger(evt.v) || evt.v < 1)
    fail(`event format version must be a positive integer, got ${JSON.stringify(evt.v)}`);
  if (!SUPPORTED_EVENT_FORMAT_VERSIONS.includes(evt.v))
    throw new UnsupportedEventVersionError(evt.v);
  if (!isUlid(evt.id)) fail('id must be a canonical 26-char ULID');
  if (!isNonEmptyStr(evt.ts) || Number.isNaN(Date.parse(evt.ts)))
    fail(`bad ts ${JSON.stringify(evt.ts)}`);
  if (!isNonEmptyStr(evt.actor)) fail('missing actor (every event must record who)');
  // Optional acting-model attribution (SCP-128): absent for human edits; when
  // present it must be a non-empty string. Forward-compatible — older readers
  // simply ignore the field.
  if (evt.model !== undefined && !isNonEmptyStr(evt.model))
    fail('model must be a non-empty string when present');
  if (evt.hlc !== undefined && !/^\d{13}-\d{6}$/.test(evt.hlc)) fail('hlc must use the canonical millis-counter format');
  if (evt.baseRevision !== undefined && !isNonEmptyStr(evt.baseRevision)) fail('baseRevision must be a non-empty string');
  if ((evt.requestId === undefined) !== (evt.requestCommand === undefined))
    fail('requestId and requestCommand must be present together');
  if (evt.requestId !== undefined && (!isNonEmptyStr(evt.requestId) || !isNonEmptyStr(evt.requestCommand)))
    fail('requestId and requestCommand must be non-empty strings');
  const hasTransactionId = evt.transactionId !== undefined;
  const hasTransactionIndex = evt.transactionIndex !== undefined;
  if (hasTransactionId !== hasTransactionIndex)
    fail('transactionId and transactionIndex must be present together');
  if (hasTransactionId) {
    if (!isUlid(evt.transactionId)) fail('transactionId must be a canonical ULID');
    if (!Number.isInteger(evt.transactionIndex) || evt.transactionIndex < 0)
      fail('transactionIndex must be a non-negative integer');
  }
  if (!EVENT_KINDS.includes(evt.kind)) fail(`unknown kind ${JSON.stringify(evt.kind)}`);
  if (!evt.payload || typeof evt.payload !== 'object') fail('missing payload');
  validatePayload(evt.kind, evt.payload);
  return evt;
}

function oneOf(label, value, allowed) {
  if (!allowed.includes(value)) fail(`${label} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`);
}

function validatePayload(kind, p) {
  switch (kind) {
    case 'transaction.commit': {
      if (!isUlid(p.transactionId)) fail('transaction.commit.transactionId must be a canonical ULID');
      if (!Array.isArray(p.eventIds) || p.eventIds.length < 2)
        fail('transaction.commit.eventIds must contain at least two event ids');
      if (p.eventIds.some((id) => !isUlid(id)))
        fail('transaction.commit.eventIds must contain canonical ULIDs');
      if (new Set(p.eventIds).size !== p.eventIds.length)
        fail('transaction.commit.eventIds must be unique');
      break;
    }

    case 'workspace.init':
      // key must match the documented 2-10 uppercase-alnum contract (SCP-198):
      // it's rendered into HTML and used as a display prefix; an unvalidated key
      // is a stored-XSS vector via the sync-push event path.
      if (!isKeyPrefix(p.key)) fail('workspace.init.key must be 2-10 uppercase alnum');
      if (!isNonEmptyStr(p.name)) fail('workspace.init.name required');
      if ('columns' in p) {
        try { normalizeColumns(p.columns); }
        catch (e) { fail(`workspace.init.columns invalid: ${e.message}`); }
      }
      break;

    case 'workspace.set': {
      const keys = ['key', 'name', 'description', 'overview', 'columns'];
      const present = keys.filter((k) => k in p);
      if (!present.length) fail('workspace.set needs at least one field');
      for (const k of present) {
        if (k === 'columns') {
          try { normalizeColumns(p[k]); }
          catch (e) { fail(`workspace.set.columns invalid: ${e.message}`); }
        } else if (!isStr(p[k])) fail(`workspace.set.${k} must be a string`);
      }
      if ('key' in p && !isKeyPrefix(p.key)) fail('workspace.set.key must be 2-10 uppercase alnum');
      break;
    }

    case 'workspace.rekey':
      // Reprefix ALL tickets to a new key (display id KEY-N -> TO-N) at replay.
      if (!isKeyPrefix(p.to)) fail('workspace.rekey.to must be 2-10 uppercase alnum');
      break;

    case 'ticket.create':
      // ticketId is the ULID identity (SCP-110); number/keyPrefix are the
      // display attributes the replay-time resolver de-collides.
      if (!isNonEmptyStr(p.ticketId)) fail('ticket.create.ticketId required');
      if (!Number.isInteger(p.number) || p.number < 1)
        fail('ticket.create.number must be a positive integer');
      if (!isKeyPrefix(p.keyPrefix)) fail('ticket.create.keyPrefix must be 2-10 uppercase alnum');
      oneOf('ticket.create.ticketType', p.ticketType, SCHEMA_TICKET_TYPES);
      if (!isNonEmptyStr(p.title)) fail('ticket.create.title required');
      if (!isStatusId(p.status)) fail('ticket.create.status must be a valid column id');
      oneOf('ticket.create.priority', p.priority, SCHEMA_PRIORITIES);
      if (!isNullableStr(p.parentId)) fail('ticket.create.parentId must be string|null');
      if (!Array.isArray(p.labels)) fail('ticket.create.labels must be an array');
      break;

    case 'ticket.set_field':
      if (!isNonEmptyStr(p.ticketId)) fail('ticket.set_field.ticketId required');
      oneOf('ticket.set_field.field', p.field, TICKET_FIELDS);
      validateFieldValue(p.field, p.value);
      break;

    case 'ticket.delete':
      if (!isNonEmptyStr(p.ticketId)) fail('ticket.delete.ticketId required');
      break;

    case 'comment.add':
      if (!isNonEmptyStr(p.ticketId)) fail('comment.add.ticketId required');
      if (!isNonEmptyStr(p.commentId)) fail('comment.add.commentId required');
      if (!isStr(p.body)) fail('comment.add.body must be a string');
      if (!isNullableStr(p.author)) fail('comment.add.author must be string|null');
      break;

    case 'artifact.put':
      if (!isNonEmptyStr(p.ticketId)) fail('artifact.put.ticketId required');
      if (!isUlid(p.artifactId)) fail('artifact.put.artifactId must be a canonical ULID');
      if (!isNonEmptyStr(p.name) || p.name.length > 160)
        fail('artifact.put.name must be 1-160 characters');
      if (p.mimeType !== 'text/html') fail('artifact.put.mimeType must be text/html');
      if (!isStr(p.content)) fail('artifact.put.content must be a string');
      if (new TextEncoder().encode(p.content).length > ARTIFACT_MAX_BYTES)
        fail(`artifact.put.content exceeds ${ARTIFACT_MAX_BYTES} bytes`);
      break;

    case 'artifact.remove':
      if (!isNonEmptyStr(p.ticketId)) fail('artifact.remove.ticketId required');
      if (!isUlid(p.artifactId)) fail('artifact.remove.artifactId must be a canonical ULID');
      break;

    case 'relation.add':
    case 'relation.remove':
      if (!isNonEmptyStr(p.fromId)) fail(`${kind}.fromId required`);
      if (!isNonEmptyStr(p.toId)) fail(`${kind}.toId required`);
      if (p.fromId === p.toId) fail(`${kind} cannot relate a ticket to itself`);
      oneOf(`${kind}.type`, p.type, SCHEMA_RELATION_TYPES);
      break;

    case 'agent.contract.set':
      if (!isNonEmptyStr(p.ticketId)) fail('agent.contract.set.ticketId required');
      if (!p.contract || typeof p.contract !== 'object') fail('agent.contract.set.contract required');
      break;
    case 'agent.lease.claim':
      if (!isNonEmptyStr(p.ticketId) || !isUlid(p.leaseId) || !isNonEmptyStr(p.agent))
        fail('agent.lease.claim requires ticketId, leaseId, and agent');
      if (!isNonEmptyStr(p.expiresAt) || Number.isNaN(Date.parse(p.expiresAt))) fail('agent.lease.claim.expiresAt invalid');
      break;
    case 'agent.lease.renew':
      if (!isUlid(p.leaseId) || !isNonEmptyStr(p.expiresAt)) fail('agent.lease.renew requires leaseId and expiresAt');
      if (p.files !== undefined && (!Array.isArray(p.files) || p.files.some((file) => !isNonEmptyStr(file))))
        fail('agent.lease.renew.files must be an array of non-empty strings');
      break;
    case 'agent.lease.release':
      if (!isUlid(p.leaseId)) fail('agent.lease.release.leaseId required');
      break;
    case 'agent.attempt.start':
      if (!isUlid(p.attemptId) || !isNonEmptyStr(p.ticketId) || !isNonEmptyStr(p.agent))
        fail('agent.attempt.start requires attemptId, ticketId, and agent');
      break;
    case 'agent.attempt.finish':
      if (!isUlid(p.attemptId) || !['succeeded', 'failed', 'handed_off', 'cancelled'].includes(p.outcome))
        fail('agent.attempt.finish requires attemptId and a valid outcome');
      break;
    case 'agent.discovery.add':
      if (!isUlid(p.discoveryId) || !isNonEmptyStr(p.ticketId) || !isNonEmptyStr(p.discoveryType) || !isStr(p.body))
        fail('agent.discovery.add requires discoveryId, ticketId, discoveryType, and body');
      break;
    case 'agent.plan.revise':
      if (!isNonEmptyStr(p.ticketId) || !Number.isInteger(p.version) || p.version < 1 || !isStr(p.body))
        fail('agent.plan.revise requires ticketId, positive version, and body');
      break;
    case 'agent.conflict.resolve':
      if (!isNonEmptyStr(p.conflictId) || !isNonEmptyStr(p.ticketId) || !isNonEmptyStr(p.field))
        fail('agent.conflict.resolve requires conflictId, ticketId, and field');
      break;
    case 'agent.register':
      if (!isAgentId(p.agentId) || !isNonEmptyStr(p.displayName))
        fail('agent.register requires a valid agentId and displayName');
      if (!Array.isArray(p.capabilities) || !p.capabilities.every(isNonEmptyStr))
        fail('agent.register.capabilities must be an array of strings');
      if (!p.metadata || typeof p.metadata !== 'object' || Array.isArray(p.metadata))
        fail('agent.register.metadata must be an object');
      if (!['online', 'busy', 'away', 'offline'].includes(p.status)) fail('agent.register.status invalid');
      if (![p.registeredAt, p.seenAt, p.expiresAt].every(isIso)) fail('agent.register timestamps invalid');
      break;
    case 'agent.heartbeat':
      if (!isAgentId(p.agentId)) fail('agent.heartbeat.agentId invalid');
      if (!['online', 'busy', 'away', 'offline'].includes(p.status)) fail('agent.heartbeat.status invalid');
      if (!Array.isArray(p.capabilities) || !p.capabilities.every(isNonEmptyStr))
        fail('agent.heartbeat.capabilities must be an array of strings');
      if (!p.metadata || typeof p.metadata !== 'object' || Array.isArray(p.metadata))
        fail('agent.heartbeat.metadata must be an object');
      if (![p.seenAt, p.expiresAt].every(isIso)) fail('agent.heartbeat timestamps invalid');
      break;
    case 'agent.message.send':
      if (!isUlid(p.messageId) || !isAgentId(p.fromAgent) || !isAgentId(p.toAgent) || p.fromAgent === p.toAgent)
        fail('agent.message.send requires a messageId and distinct valid agents');
      if (!/^[a-z][a-z0-9_]{1,31}$/.test(p.kind ?? '')) fail('agent.message.send.kind invalid');
      if (!isNonEmptyStr(p.body) || new TextEncoder().encode(p.body).length > 64 * 1024)
        fail('agent.message.send.body invalid');
      if (!Array.isArray(p.artifactRefs)) fail('agent.message.send.artifactRefs must be an array');
      if (!isUlid(p.threadId)) fail('agent.message.send.threadId invalid');
      if (p.replyTo !== null && p.replyTo !== undefined && !isUlid(p.replyTo)) fail('agent.message.send.replyTo invalid');
      if (p.ticketId !== null && p.ticketId !== undefined && !isNonEmptyStr(p.ticketId)) fail('agent.message.send.ticketId invalid');
      if (p.correlationId !== null && p.correlationId !== undefined && !isNonEmptyStr(p.correlationId))
        fail('agent.message.send.correlationId invalid');
      if (!isIso(p.createdAt) || (p.expiresAt !== null && p.expiresAt !== undefined && !isIso(p.expiresAt)))
        fail('agent.message.send timestamps invalid');
      break;
    case 'agent.message.ack':
      if (!isUlid(p.messageId) || !isAgentId(p.agent) || !isIso(p.acknowledgedAt))
        fail('agent.message.ack requires messageId, agent, and acknowledgedAt');
      break;

    default:
      fail(`no payload validator for kind ${kind}`);
  }
}

function validateFieldValue(field, value) {
  switch (field) {
    case 'status':
      if (!isStatusId(value)) fail('status value must be a valid column id');
      break;
    case 'priority':
      oneOf('priority', value, SCHEMA_PRIORITIES);
      break;
    case 'labels':
      if (!Array.isArray(value)) fail('labels value must be an array');
      break;
    case 'title':
      if (!isNonEmptyStr(value)) fail('title value must be a non-empty string');
      break;
    case 'description':
      if (!isStr(value)) fail('description value must be a string');
      break;
    // rank is a finite number (fractional, for ordering) or null to clear it.
    case 'rank':
      if (value !== null && !(typeof value === 'number' && Number.isFinite(value)))
        fail('rank value must be a finite number or null');
      break;
    // parentId, branch, prUrl, assignee are all nullable strings
    case 'parentId':
    case 'branch':
    case 'prUrl':
    case 'assignee':
      if (!isNullableStr(value)) fail(`${field} value must be string|null`);
      break;
    default:
      fail(`unknown field ${field}`);
  }
}

/* ------------------------ canonical order ------------------------ */

/**
 * Canonical total order over events. Primary: wall-clock `ts` (most recent
 * intent wins). Tiebreak: the globally-unique ULID `id`, which is monotonic
 * within a process — so two events a peer produced in the same millisecond
 * still sort in creation order. `id` alone is a complete total order after
 * `ts` (it is unique), so no further tiebreak is needed; `actor` is
 * deliberately NOT used, because tiebreaking on actor name would reorder
 * same-millisecond events by different actors away from the order they actually
 * happened. Every peer computes the identical order from the same event set,
 * which is what makes replay deterministic (SCP-109) and LWW well-defined
 * (SCP-110).
 */
export function compareEvents(a, b) {
  if (a.hlc && b.hlc && a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export { EventValidationError, UnsupportedEventVersionError };
