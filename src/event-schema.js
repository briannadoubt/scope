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

export { ulid, TICKET_FIELDS };

/** Current event-envelope version. Bump only on a breaking format change. */
export const EVENT_FORMAT_VERSION = 1;

/** The closed set of legal `kind` values. */
export const EVENT_KINDS = Object.freeze([
  'workspace.init',
  'workspace.set',
  'workspace.rekey',
  'ticket.create',
  'ticket.set_field',
  'ticket.delete',
  'comment.add',
  'relation.add',
  'relation.remove',
]);

/* --------------------------- builder --------------------------- */

/**
 * Build a validated event envelope.
 *
 * @param {string} kind - one of EVENT_KINDS
 * @param {object} payload - kind-specific payload (see docs/event-log-format.md)
 * @param {object} opts
 * @param {string} opts.actor - required; who caused the change
 * @param {string} [opts.ts] - ISO timestamp; defaults to now
 * @param {number} [opts.ms] - epoch ms for the ULID; defaults to Date.parse(ts) or now
 * @returns {object} the event
 */
export function makeEvent(kind, payload, { actor, ts, ms } = {}) {
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
  validateEvent(evt);
  return evt;
}

/* -------------------------- validation -------------------------- */

class EventValidationError extends Error {}

function fail(msg) {
  throw new EventValidationError(`Invalid event: ${msg}`);
}

const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
const isNullableStr = (v) => v === null || typeof v === 'string';
// Same shape updateWorkspace enforces for a workspace key.
const isKeyPrefix = (v) => typeof v === 'string' && /^[A-Z][A-Z0-9]{1,9}$/.test(v);

/**
 * Throw EventValidationError if `evt` violates the spec. Used by the writer
 * (reject bad writes, SCP-108) and the reader (reject corrupt files, SCP-109).
 */
export function validateEvent(evt) {
  if (!evt || typeof evt !== 'object') fail('not an object');
  if (evt.v !== EVENT_FORMAT_VERSION)
    fail(`unsupported version ${JSON.stringify(evt.v)} (expected ${EVENT_FORMAT_VERSION})`);
  if (!isNonEmptyStr(evt.id)) fail('missing id');
  if (!isNonEmptyStr(evt.ts) || Number.isNaN(Date.parse(evt.ts)))
    fail(`bad ts ${JSON.stringify(evt.ts)}`);
  if (!isNonEmptyStr(evt.actor)) fail('missing actor (every event must record who)');
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
    case 'workspace.init':
      if (!isNonEmptyStr(p.key)) fail('workspace.init.key required');
      if (!isNonEmptyStr(p.name)) fail('workspace.init.name required');
      break;

    case 'workspace.set': {
      const keys = ['key', 'name', 'description', 'overview'];
      const present = keys.filter((k) => k in p);
      if (!present.length) fail('workspace.set needs at least one field');
      for (const k of present) if (!isStr(p[k])) fail(`workspace.set.${k} must be a string`);
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
      oneOf('ticket.create.status', p.status, SCHEMA_STATUSES);
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

    case 'relation.add':
    case 'relation.remove':
      if (!isNonEmptyStr(p.fromId)) fail(`${kind}.fromId required`);
      if (!isNonEmptyStr(p.toId)) fail(`${kind}.toId required`);
      if (p.fromId === p.toId) fail(`${kind} cannot relate a ticket to itself`);
      oneOf(`${kind}.type`, p.type, SCHEMA_RELATION_TYPES);
      break;

    default:
      fail(`no payload validator for kind ${kind}`);
  }
}

function validateFieldValue(field, value) {
  switch (field) {
    case 'status':
      oneOf('status', value, SCHEMA_STATUSES);
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
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export { EventValidationError };
