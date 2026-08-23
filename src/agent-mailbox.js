import { ulid } from './ulid.js';
import { parseDuration } from './agent-runtime.js';
import { emitDomainChange, emitDomainEvent, withEventMutation } from './repo.js';
import { ScopeCliError } from './protocol.js';

export const AGENT_PRESENCE_STATUSES = Object.freeze(['online', 'busy', 'away', 'offline']);
export const MESSAGE_KINDS = Object.freeze([
  'question',
  'task_request',
  'review_request',
  'evidence',
  'result',
  'challenge',
  'handoff',
  'blocked',
  'status',
  'reply',
]);

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,127}$/;
const MESSAGE_KIND_RE = /^[a-z][a-z0-9_]{1,31}$/;
const MAX_BODY_BYTES = 64 * 1024;

const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};

function nowDate(value) {
  return value instanceof Date ? value : value ? new Date(value) : new Date();
}

function assertAgentId(value, label = 'agent') {
  const id = String(value ?? '').trim();
  if (!AGENT_ID_RE.test(id)) {
    throw new ScopeCliError(`${label} must be 1-128 letters, numbers, or :._/@- characters`, {
      code: 'INVALID_AGENT_ID',
    });
  }
  return id;
}

function assertStatus(value) {
  const status = value ?? 'online';
  if (!AGENT_PRESENCE_STATUSES.includes(status)) {
    throw new ScopeCliError(`status must be one of ${AGENT_PRESENCE_STATUSES.join('|')}`, {
      code: 'INVALID_AGENT_STATUS',
    });
  }
  return status;
}

function assertObject(value, label) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ScopeCliError(`${label} must be a JSON object`, { code: 'INVALID_ARGUMENT' });
  }
  return value;
}

function assertArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ScopeCliError(`${label} must be a JSON array`, { code: 'INVALID_ARGUMENT' });
  return value;
}

function presenceRow(row, now = new Date()) {
  if (!row) return null;
  const expired = row.expires_at <= now.toISOString();
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    provider: row.provider,
    capabilities: parse(row.capabilities, []),
    metadata: parse(row.metadata, {}),
    declaredStatus: row.status,
    status: row.status === 'offline' || expired ? 'offline' : row.status,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    stale: expired,
  };
}

function deliveryStatus(row, now = new Date()) {
  if (row.acked_at) return 'acknowledged';
  if (row.expires_at && row.expires_at <= now.toISOString()) return 'expired';
  return 'pending';
}

function messageRow(row, now = new Date()) {
  if (!row) return null;
  return {
    messageId: row.message_id,
    ticketId: row.ticket_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    kind: row.kind,
    body: row.body,
    artifactRefs: parse(row.artifact_refs, []),
    threadId: row.thread_id,
    replyTo: row.reply_to,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acknowledgedAt: row.acked_at,
    acknowledgedBy: row.acked_by,
    deliveryStatus: deliveryStatus(row, now),
  };
}

export function getAgent(db, agentId, { now = new Date() } = {}) {
  const id = assertAgentId(agentId);
  return presenceRow(db.prepare('SELECT * FROM agent_registry WHERE agent_id=?').get(id), nowDate(now));
}

export function listAgents(db, { includeOffline = true, now = new Date() } = {}) {
  const agents = db.prepare('SELECT * FROM agent_registry ORDER BY agent_id').all()
    .map((row) => presenceRow(row, nowDate(now)));
  return includeOffline ? agents : agents.filter((agent) => agent.status !== 'offline');
}

export function registerAgent(db, agentId, options = {}) {
  const id = assertAgentId(agentId);
  const status = assertStatus(options.status);
  const capabilities = assertArray(options.capabilities, 'capabilities').map(String);
  const metadata = assertObject(options.metadata, 'metadata');
  const now = nowDate(options.now);
  const seenAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + parseDuration(options.ttl ?? '2m')).toISOString();
  const actor = options.actor ?? id;
  return withEventMutation(db, () => {
    const existing = db.prepare('SELECT registered_at FROM agent_registry WHERE agent_id=?').get(id);
    const registeredAt = existing?.registered_at ?? seenAt;
    db.prepare(`INSERT INTO agent_registry
      (agent_id,display_name,provider,capabilities,metadata,status,registered_at,last_seen_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET
        display_name=excluded.display_name,provider=excluded.provider,
        capabilities=excluded.capabilities,metadata=excluded.metadata,status=excluded.status,
        last_seen_at=excluded.last_seen_at,expires_at=excluded.expires_at`).run(
      id, options.displayName ?? id, options.provider ?? null, json(capabilities), json(metadata),
      status, registeredAt, seenAt, expiresAt
    );
    emitDomainEvent(db, 'agent.register', {
      agentId: id, displayName: options.displayName ?? id, provider: options.provider ?? null,
      capabilities, metadata, status, registeredAt, seenAt, expiresAt,
    }, actor, options.model);
    emitDomainChange({ type: 'agent.registered', agentId: id, status });
    return getAgent(db, id, { now });
  });
}

export function heartbeatAgent(db, agentId, options = {}) {
  const id = assertAgentId(agentId);
  const current = db.prepare('SELECT * FROM agent_registry WHERE agent_id=?').get(id);
  if (!current) throw new ScopeCliError(`Agent not found: ${id}`, { code: 'NOT_FOUND' });
  const status = assertStatus(options.status ?? current.status);
  const capabilities = options.capabilities === undefined
    ? parse(current.capabilities, [])
    : assertArray(options.capabilities, 'capabilities').map(String);
  const metadata = options.metadata === undefined
    ? parse(current.metadata, {})
    : assertObject(options.metadata, 'metadata');
  const now = nowDate(options.now);
  const seenAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + parseDuration(options.ttl ?? '2m')).toISOString();
  const actor = options.actor ?? id;
  return withEventMutation(db, () => {
    db.prepare(`UPDATE agent_registry SET status=?,capabilities=?,metadata=?,last_seen_at=?,expires_at=?
      WHERE agent_id=?`).run(status, json(capabilities), json(metadata), seenAt, expiresAt, id);
    emitDomainEvent(db, 'agent.heartbeat', {
      agentId: id, status, capabilities, metadata, seenAt, expiresAt,
    }, actor, options.model);
    emitDomainChange({ type: 'agent.heartbeat', agentId: id, status });
    return getAgent(db, id, { now });
  });
}

export function getMessage(db, messageId, { now = new Date() } = {}) {
  return messageRow(db.prepare('SELECT * FROM agent_messages WHERE message_id=?').get(messageId), nowDate(now));
}

function resolveTicket(db, ticketId) {
  if (!ticketId) return null;
  const row = db.prepare('SELECT id,uid FROM tickets WHERE id=? OR uid=?').get(ticketId, ticketId);
  if (!row) throw new ScopeCliError(`Ticket not found: ${ticketId}`, { code: 'NOT_FOUND' });
  return row;
}

export function sendMessage(db, options = {}) {
  const fromAgent = assertAgentId(options.fromAgent, 'from agent');
  const toAgent = assertAgentId(options.toAgent, 'to agent');
  if (fromAgent === toAgent) throw new ScopeCliError('message sender and recipient must differ', { code: 'INVALID_ARGUMENT' });
  const kind = String(options.kind ?? 'question');
  if (!MESSAGE_KIND_RE.test(kind)) {
    throw new ScopeCliError('message kind must be 2-32 lowercase letters, numbers, or underscores', {
      code: 'INVALID_MESSAGE_KIND',
    });
  }
  const body = String(options.body ?? '').trim();
  if (!body) throw new ScopeCliError('message body is required', { code: 'INVALID_ARGUMENT' });
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    throw new ScopeCliError(`message body exceeds ${MAX_BODY_BYTES} bytes`, { code: 'MESSAGE_TOO_LARGE' });
  }
  const artifactRefs = assertArray(options.artifactRefs, 'artifactRefs');
  const ticket = resolveTicket(db, options.ticketId);
  const reply = options.replyTo ? getMessage(db, options.replyTo) : null;
  if (options.replyTo && !reply) throw new ScopeCliError(`Message not found: ${options.replyTo}`, { code: 'NOT_FOUND' });
  if (reply && options.threadId && options.threadId !== reply.threadId) {
    throw new ScopeCliError('reply thread does not match the parent message', { code: 'THREAD_MISMATCH' });
  }
  const now = nowDate(options.now);
  const createdAt = now.toISOString();
  const messageId = options.messageId ?? ulid(now.getTime());
  const threadId = reply?.threadId ?? options.threadId ?? messageId;
  const expiresAt = options.ttl ? new Date(now.getTime() + parseDuration(options.ttl)).toISOString() : null;
  const actor = options.actor ?? fromAgent;
  return withEventMutation(db, () => {
    db.prepare(`INSERT INTO agent_messages
      (message_id,ticket_id,from_agent,to_agent,kind,body,artifact_refs,thread_id,reply_to,correlation_id,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      messageId, ticket?.id ?? null, fromAgent, toAgent, kind, body, json(artifactRefs), threadId,
      options.replyTo ?? null, options.correlationId ?? null, createdAt, expiresAt
    );
    emitDomainEvent(db, 'agent.message.send', {
      messageId, ticketId: ticket?.uid ?? null, fromAgent, toAgent, kind, body, artifactRefs,
      threadId, replyTo: options.replyTo ?? null, correlationId: options.correlationId ?? null,
      createdAt, expiresAt,
    }, actor, options.model);
    emitDomainChange({
      type: 'agent.message.sent', messageId, ticketId: ticket?.id ?? null,
      fromAgent, toAgent, threadId,
    });
    return getMessage(db, messageId, { now });
  });
}

export function replyToMessage(db, messageId, options = {}) {
  const parent = getMessage(db, messageId);
  if (!parent) throw new ScopeCliError(`Message not found: ${messageId}`, { code: 'NOT_FOUND' });
  const fromAgent = assertAgentId(options.fromAgent, 'from agent');
  let toAgent;
  if (fromAgent === parent.toAgent) toAgent = parent.fromAgent;
  else if (fromAgent === parent.fromAgent) toAgent = parent.toAgent;
  else throw new ScopeCliError('reply sender is not a participant in the conversation', { code: 'MESSAGE_PARTICIPANT' });
  return sendMessage(db, {
    ...options,
    fromAgent,
    toAgent,
    kind: options.kind ?? 'reply',
    ticketId: options.ticketId ?? parent.ticketId,
    threadId: parent.threadId,
    replyTo: parent.messageId,
    correlationId: options.correlationId ?? parent.correlationId,
  });
}

export function listInbox(db, agentId, options = {}) {
  const id = assertAgentId(agentId);
  const where = ['to_agent=?'];
  const params = [id];
  if (!options.includeAcknowledged) where.push('acked_at IS NULL');
  if (!options.includeExpired) {
    where.push('(expires_at IS NULL OR expires_at>?)');
    params.push(nowDate(options.now).toISOString());
  }
  if (options.since) { where.push('message_id>?'); params.push(options.since); }
  if (options.ticketId) { where.push('ticket_id=?'); params.push(options.ticketId); }
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000));
  return db.prepare(`SELECT * FROM agent_messages WHERE ${where.join(' AND ')}
    ORDER BY created_at,message_id LIMIT ?`).all(...params, limit)
    .map((row) => messageRow(row, nowDate(options.now)));
}

export function listConversation(db, threadId, options = {}) {
  const rows = db.prepare('SELECT * FROM agent_messages WHERE thread_id=? ORDER BY created_at,message_id').all(threadId);
  if (options.agentId) {
    const agent = assertAgentId(options.agentId);
    if (!rows.some((row) => row.from_agent === agent || row.to_agent === agent)) {
      throw new ScopeCliError('agent is not a participant in this conversation', { code: 'MESSAGE_PARTICIPANT' });
    }
  }
  return rows.map((row) => messageRow(row, nowDate(options.now)));
}

export function acknowledgeMessage(db, messageId, options = {}) {
  const agent = assertAgentId(options.agent, 'acknowledging agent');
  const current = db.prepare('SELECT * FROM agent_messages WHERE message_id=?').get(messageId);
  if (!current) throw new ScopeCliError(`Message not found: ${messageId}`, { code: 'NOT_FOUND' });
  if (current.to_agent !== agent) {
    throw new ScopeCliError('only the addressed recipient can acknowledge a message', {
      code: 'MESSAGE_RECIPIENT',
    });
  }
  if (current.acked_at) return messageRow(current, nowDate(options.now));
  const now = nowDate(options.now);
  const acknowledgedAt = now.toISOString();
  const actor = options.actor ?? agent;
  return withEventMutation(db, () => {
    db.prepare('UPDATE agent_messages SET acked_at=?,acked_by=? WHERE message_id=? AND acked_at IS NULL')
      .run(acknowledgedAt, agent, messageId);
    emitDomainEvent(db, 'agent.message.ack', {
      messageId, agent, acknowledgedAt,
    }, actor, options.model);
    emitDomainChange({
      type: 'agent.message.acknowledged', messageId, fromAgent: current.from_agent,
      toAgent: current.to_agent, threadId: current.thread_id,
    });
    return getMessage(db, messageId, { now });
  });
}
