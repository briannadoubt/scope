import { createHash } from 'node:crypto';
import { ScopeCliError } from './protocol.js';

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const hash = (text) => createHash('sha256').update(text).digest('hex');

export function contextOptions({ budget = 4000, since = null, cursor = null, detail = null } = {}) {
  budget = Number(budget);
  if (!Number.isSafeInteger(budget) || budget < 256 || budget > 262144) {
    throw new ScopeCliError('budget must be an integer between 256 and 262144');
  }
  let continuation = null;
  if (cursor) {
    if (since || detail) throw new ScopeCliError('cursor cannot be combined with since or detail');
    try {
      if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[\w-]+$/.test(cursor)) throw new Error();
      continuation = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (continuation.v !== 2 || !['page', 'detail'].includes(continuation.kind)
        || !/^[a-f0-9]{64}$/.test(continuation.hash)
        || !Number.isSafeInteger(continuation.offset) || continuation.offset < 1
        || (continuation.since != null && typeof continuation.since !== 'string')) throw new Error();
    } catch { throw new ScopeCliError('invalid context cursor'); }
    since = continuation.since ?? null;
    detail = continuation.kind === 'detail' ? continuation.hash : null;
  }
  if (since != null && (typeof since !== 'string' || since.length > 100)) throw new ScopeCliError('invalid context since');
  if (detail != null && (typeof detail !== 'string' || !/^[a-f0-9]{64}$/.test(detail))) throw new ScopeCliError('invalid context detail reference');
  if (detail && since) throw new ScopeCliError('detail cannot be combined with since');
  return { budget, since, detail, continuation };
}

// Account for the accounting fields themselves, including a digit-boundary change.
function measured(value) {
  value.outputBytes = 0;
  value.approximateTokens = 0;
  for (;;) {
    const text = JSON.stringify(value);
    const outputBytes = Buffer.byteLength(text);
    const approximateTokens = Math.ceil(text.length / 4);
    if (value.outputBytes === outputBytes && value.approximateTokens === approximateTokens) return value;
    value.outputBytes = outputBytes;
    value.approximateTokens = approximateTokens;
  }
}

/** A normalized index: execution links to records instead of embedding their bodies. */
function contextRecords(pack) {
  const details = new Map();
  const reference = (value) => {
    const text = JSON.stringify(value);
    const ref = hash(text);
    details.set(ref, text);
    return { ref, bytes: Buffer.byteLength(text) };
  };
  const records = [];
  const add = (section, value) => {
    const detail = reference(value);
    const id = value?.discoveryId ?? value?.attemptId ?? value?.leaseId ?? value?.id ?? value?.version;
    const identity = id == null ? {} : { id };
    // Fixed threshold keeps the index stable when a caller changes page budgets.
    records.push(detail.bytes > 512 ? { section, ...identity, detail } : { section, ...identity, value });
  };
  const { execution: _execution, lease: _lease, ...ready } = pack.readiness;
  const { lease, attempt, latestDiscovery, latestHandoff, verification, ...execution } = pack.execution;
  add('readiness', ready);
  add('execution', { ...execution, leaseId: lease?.leaseId ?? null, attemptId: attempt?.attemptId ?? null,
    latestDiscoveryId: latestDiscovery?.discoveryId ?? null, latestHandoffId: latestHandoff?.discoveryId ?? null,
    verification: { ...verification, results: undefined, resultsAttemptId: attempt?.attemptId ?? null } });
  add('contract', pack.contract);
  add('ticket', pack.ticket);
  if (lease) add('leases', lease);
  const discoveries = new Map(pack.discoveries.map((item) => [item.discoveryId, item]));
  for (const item of [latestHandoff, latestDiscovery]) if (item) discoveries.set(item.discoveryId, item);
  for (const item of discoveries.values()) add('discoveries', item);
  for (const section of ['relations', 'comments', 'attempts', 'plans']) for (const item of pack[section]) add(section, item);
  for (const { payload, ...event } of pack.changes) add('changes', { ...event, payload: reference(payload) });
  return { records, details };
}

export function boundedContext(pack, eventCursor, options) {
  const { budget, since, detail, continuation } = options;
  const maxBytes = budget * 4;
  if (!detail && !continuation) {
    const legacy = measured({ ...pack, truncated: false, complete: true, nextCursor: null, cursor: eventCursor });
    if (legacy.outputBytes <= maxBytes) return legacy;
  }
  const { records, details } = contextRecords(pack);
  if (detail) {
    const text = details.get(detail);
    if (text === undefined) throw new ScopeCliError('context detail is no longer available; refresh context', {
      code: 'CONTEXT_DETAIL_NOT_FOUND', retryable: true,
    });
    const offset = continuation?.offset ?? 0;
    if (offset >= text.length) throw new ScopeCliError('invalid context detail offset');
    const page = (length) => {
      const end = offset + length;
      return measured({ view: 'context-detail-v1', ref: detail, encoding: 'json', offset,
        totalChars: text.length, text: text.slice(offset, end), complete: end === text.length,
        truncated: end < text.length,
        nextCursor: end === text.length ? null : encode({ v: 2, kind: 'detail', hash: detail, offset: end }) });
    };
    // Measure escaped JSON and UTF-8, not just the number of source characters.
    let low = 0;
    let high = Math.min(text.length - offset, maxBytes);
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (page(mid).outputBytes <= maxBytes) low = mid;
      else high = mid - 1;
    }
    if (!low) throw new ScopeCliError('budget too small for context detail');
    return page(low);
  }
  const snapshot = hash(JSON.stringify({ uid: pack.ticket.uid, since, eventCursor, records }));
  if (continuation && continuation.hash !== snapshot) throw new ScopeCliError('context snapshot changed; restart with the previous since cursor', {
    code: 'STALE_CURSOR', retryable: true,
  });
  const offset = continuation?.offset ?? 0;
  if (offset >= records.length) throw new ScopeCliError('invalid context page offset');
  const displayRecords = records.map((record) => {
    if (record.value === undefined || Buffer.byteLength(JSON.stringify(record)) <= maxBytes / 5) return record;
    const { value, ...rest } = record;
    const text = JSON.stringify(value);
    return { ...rest, detail: { ref: hash(text), bytes: Buffer.byteLength(text) } };
  });
  const page = (end) => measured({
    view: 'context-v2', snapshot,
    ticket: { id: pack.ticket.id, status: pack.ticket.status },
    readiness: { state: pack.readiness.state }, execution: { phase: pack.execution.phase },
    records: displayRecords.slice(offset, end), complete: end === records.length,
    // Details remain explicitly retrievable even when the index is complete.
    truncated: true,
    nextCursor: end === records.length ? null : encode({ v: 2, kind: 'page', hash: snapshot, offset: end, since }),
    cursor: end === records.length ? eventCursor : null,
    detail: 'Fetch refs with context <ticketId> --detail <ref>; follow nextCursor with --cursor. Detail text chunks concatenate to JSON.',
  });
  let end = offset;
  while (end < records.length && page(end + 1).outputBytes <= maxBytes) end += 1;
  if (end === offset) throw new ScopeCliError('budget too small for one context record; increase --budget', {
    code: 'CONTEXT_RECORD_TOO_LARGE',
  });
  return page(end);
}
