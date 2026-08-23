import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { ensureEventLog } from '../src/backfill.js';
import { eventsDir, readAllEvents } from '../src/event-store.js';
import { replayInto } from '../src/replay.js';
import { createTicket, deleteTicket } from '../src/repo.js';
import {
  acknowledgeMessage,
  getAgent,
  getMessage,
  heartbeatAgent,
  listAgents,
  listConversation,
  listInbox,
  registerAgent,
  replyToMessage,
  sendMessage,
} from '../src/agent-mailbox.js';

test('agent presence is heartbeat-based and becomes stale deterministically', () => {
  const { db, cleanup } = createTempScope();
  try {
    const start = new Date('2026-08-23T10:00:00.000Z');
    const opus = registerAgent(db, 'claude:opus', {
      displayName: 'Opus', provider: 'anthropic', capabilities: ['review'],
      metadata: { host: 'claude-code' }, ttl: '30s', now: start,
    });
    assert.equal(opus.status, 'online');
    assert.equal(getAgent(db, 'claude:opus', { now: new Date(start.getTime() + 31_000) }).status, 'offline');

    const renewed = heartbeatAgent(db, 'claude:opus', {
      status: 'busy', ttl: '2m', now: new Date(start.getTime() + 31_000),
    });
    assert.equal(renewed.status, 'busy');
    assert.deepEqual(renewed.capabilities, ['review']);
    assert.equal(listAgents(db, { includeOffline: false, now: new Date(start.getTime() + 32_000) }).length, 1);
  } finally {
    cleanup();
  }
});

test('addressed messages retry until acknowledgement and form direct threads', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    ensureEventLog(db, scopeDir);
    registerAgent(db, 'codex:sol', { displayName: 'Sol', provider: 'openai' });
    registerAgent(db, 'claude:opus', { displayName: 'Opus', provider: 'anthropic' });
    const ticket = createTicket(db, { type: 'story', title: 'Cross-agent work', actor: 'planner' });
    const sent = sendMessage(db, {
      fromAgent: 'codex:sol', toAgent: 'claude:opus', kind: 'review_request',
      body: 'Try to falsify the mailbox invariants.', ticketId: ticket.id,
      artifactRefs: [{ type: 'commit', value: 'abc123' }], correlationId: 'review-1',
    });
    assert.equal(sent.deliveryStatus, 'pending');
    assert.equal(sent.threadId, sent.messageId);
    assert.equal(listInbox(db, 'claude:opus').length, 1);
    assert.equal(listInbox(db, 'claude:opus').length, 1, 'unacked delivery is retryable');
    assert.throws(() => acknowledgeMessage(db, sent.messageId, { agent: 'codex:sol' }), /addressed recipient/);

    const reply = replyToMessage(db, sent.messageId, {
      fromAgent: 'claude:opus', body: 'The replay path needs an orphan-ticket check.',
    });
    assert.equal(reply.toAgent, 'codex:sol');
    assert.equal(reply.threadId, sent.threadId);
    assert.equal(reply.replyTo, sent.messageId);
    assert.equal(listConversation(db, sent.threadId, { agentId: 'claude:opus' }).length, 2);
    assert.throws(() => listConversation(db, sent.threadId, { agentId: 'other:agent' }), /not a participant/);

    const acked = acknowledgeMessage(db, sent.messageId, { agent: 'claude:opus' });
    assert.equal(acked.deliveryStatus, 'acknowledged');
    assert.equal(listInbox(db, 'claude:opus').length, 0);
    assert.equal(listInbox(db, 'claude:opus', { includeAcknowledged: true }).length, 1);
    assert.equal(acknowledgeMessage(db, sent.messageId, { agent: 'claude:opus' }).acknowledgedAt, acked.acknowledgedAt,
      'acknowledgement is idempotent');

    replayInto(db, readAllEvents(eventsDir(scopeDir)));
    assert.equal(getAgent(db, 'codex:sol').provider, 'openai');
    assert.equal(getMessage(db, sent.messageId).deliveryStatus, 'acknowledged');
    assert.equal(listConversation(db, sent.threadId, { agentId: 'codex:sol' }).length, 2);

    deleteTicket(db, ticket.id, 'planner');
    assert.equal(getMessage(db, sent.messageId).ticketId, null, 'ticket deletion preserves the conversation');
    replayInto(db, readAllEvents(eventsDir(scopeDir)));
    assert.equal(getMessage(db, sent.messageId).ticketId, null, 'replay preserves orphan handling');
  } finally {
    cleanup();
  }
});

test('expired messages leave the pending inbox but remain auditable', () => {
  const { db, cleanup } = createTempScope();
  try {
    const start = new Date('2026-08-23T12:00:00.000Z');
    const sent = sendMessage(db, {
      fromAgent: 'codex:sol', toAgent: 'claude:opus', body: 'Short-lived ping', ttl: '30s', now: start,
    });
    const later = new Date(start.getTime() + 31_000);
    assert.equal(listInbox(db, 'claude:opus', { now: later }).length, 0);
    const audit = listInbox(db, 'claude:opus', { now: later, includeExpired: true });
    assert.equal(audit[0].messageId, sent.messageId);
    assert.equal(audit[0].deliveryStatus, 'expired');
  } finally {
    cleanup();
  }
});
