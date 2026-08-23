import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { createTempScope } from './helpers.js';
import { createTicket, updateWorkspace } from '../src/repo.js';

function mcpClient(scopeDir) {
  const child = spawn(process.execPath, [resolve('plugins/scope/mcp/server.mjs')], {
    env: { ...process.env, SCOPE_BIN: resolve('bin/scope.js'), SCOPE_DIR: scopeDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const waiting = new Map();
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.slice(0, headerEnd).toString());
      if (!match) throw new Error('bad MCP frame');
      const length = Number(match[1]);
      const end = headerEnd + 4 + length;
      if (buffer.length < end) break;
      const message = JSON.parse(buffer.slice(headerEnd + 4, end).toString());
      buffer = buffer.slice(end);
      const waiter = waiting.get(message.id);
      if (waiter) {
        waiting.delete(message.id);
        message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
      }
    }
  });
  return {
    call(method, params = {}) {
      const id = nextId++;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 5000);
        waiting.set(id, {
          resolve: (value) => { clearTimeout(timer); resolvePromise(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
      });
    },
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

test('MCP adapter unwraps protocol envelopes and drives the agent lifecycle', async () => {
  const scope = createTempScope();
  updateWorkspace(scope.db, { key: 'MCP', name: 'MCP' });
  const ticket = createTicket(scope.db, { type: 'story', title: 'MCP work', status: 'todo' });
  scope.db.close();
  const client = mcpClient(scope.scopeDir);
  try {
    const capabilities = await client.call('tools/call', {
      name: 'scope_capabilities', arguments: {},
    });
    assert.equal(capabilities.structuredContent.protocolVersion, '1.0');
    assert.equal(capabilities.structuredContent.features.addressedMessaging, true);

    for (const [agent, provider] of [['codex:sol', 'openai'], ['claude:opus', 'anthropic']]) {
      const registered = await client.call('tools/call', {
        name: 'scope_agent_register', arguments: { agent, provider, capabilities: ['review'] },
      });
      assert.equal(registered.structuredContent.status, 'online');
    }

    const message = await client.call('tools/call', {
      name: 'scope_message_send', arguments: {
        from: 'codex:sol', to: 'claude:opus', body: 'Review the MCP bridge', kind: 'review_request',
        requestId: 'message-1',
      },
    });
    const messageRetry = await client.call('tools/call', {
      name: 'scope_message_send', arguments: {
        from: 'codex:sol', to: 'claude:opus', body: 'Review the MCP bridge', kind: 'review_request',
        requestId: 'message-1',
      },
    });
    assert.equal(messageRetry.structuredContent.messageId, message.structuredContent.messageId,
      'stable request id prevents duplicate delivery');
    const inbox = await client.call('tools/call', {
      name: 'scope_message_inbox', arguments: { agent: 'claude:opus' },
    });
    assert.equal(inbox.structuredContent[0].messageId, message.structuredContent.messageId);
    const reply = await client.call('tools/call', {
      name: 'scope_message_reply', arguments: {
        messageId: message.structuredContent.messageId, from: 'claude:opus', body: 'MCP bridge reviewed',
      },
    });
    assert.equal(reply.structuredContent.toAgent, 'codex:sol');
    const ack = await client.call('tools/call', {
      name: 'scope_message_ack', arguments: {
        messageId: message.structuredContent.messageId, agent: 'claude:opus',
      },
    });
    assert.equal(ack.structuredContent.deliveryStatus, 'acknowledged');

    const board = await client.call('tools/call', { name: 'scope_board', arguments: {} });
    assert.ok(board.structuredContent.columns.some((column) =>
      column.tickets.some((item) => item.id === ticket.id)));

    const ready = await client.call('tools/call', { name: 'scope_ready', arguments: {} });
    assert.ok(ready.structuredContent.some((item) => item.ticket.id === ticket.id));

    const plan = await client.call('tools/call', { name: 'scope_ready', arguments: { plan: true } });
    assert.ok(plan.structuredContent.unresolvedIntent.includes(ticket.id));

    const claim = await client.call('tools/call', {
      name: 'scope_claim', arguments: { id: ticket.id, agent: 'mcp-agent', requestId: 'claim-1' },
    });
    assert.equal(claim.structuredContent.lease.agent, 'mcp-agent');
    assert.equal(claim.structuredContent.ticket.status, 'in_progress');

    const context = await client.call('tools/call', {
      name: 'scope_context', arguments: { id: ticket.id },
    });
    assert.equal(context.structuredContent.readiness.state, 'claimed');
    assert.equal(context.structuredContent.execution.phase, 'running');

    const handoff = await client.call('tools/call', {
      name: 'scope_handoff', arguments: {
        id: ticket.id, agent: 'mcp-agent', attemptId: claim.structuredContent.attempt.attemptId,
        summary: 'Continue with verification', remaining: ['Run tests'], requestId: 'handoff-1',
      },
    });
    assert.equal(handoff.structuredContent.attempt.status, 'handed_off');

    const reclaimed = await client.call('tools/call', {
      name: 'scope_claim', arguments: { id: ticket.id, agent: 'mcp-agent-2', requestId: 'claim-2' },
    });

    const complete = await client.call('tools/call', {
      name: 'scope_complete', arguments: {
        id: ticket.id,
        attemptId: reclaimed.structuredContent.attempt.attemptId,
        agent: 'mcp-agent-2',
        requestId: 'complete-1',
      },
    });
    assert.equal(complete.structuredContent.ticket.status, 'done');
  } finally {
    client.close();
    scope.cleanup();
  }
});
