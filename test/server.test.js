import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, apiFetch } from './helpers.js';
import { bindSession } from '../src/session-bridge.js';

test('GET /api/meta returns enums and hub info', async () => {
  const t = await startTestServer();
  try {
    const { status, data } = await apiFetch(t.baseUrl, '/api/meta');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.statuses) && data.statuses.includes('done'));
    assert.ok(Array.isArray(data.priorities) && data.priorities.includes('urgent'));
    assert.ok(Array.isArray(data.ticket_types) && data.ticket_types.includes('epic'));
    assert.ok(Array.isArray(data.relation_types) && data.relation_types.includes('blocks'));
    assert.ok(data.hub && Array.isArray(data.hub.workspaces));
    assert.equal(data.agent_protocol.version, '1.0');
    assert.equal(data.agent_protocol.features.leases, true);
    // SCP-57: security descriptor advertised on the API too (TXT and meta
    // carry the same info for clients that discover via different paths).
    assert.equal(data.security.scheme, 'http'); // tls:false in test helper
    assert.deepEqual(data.security.auth, ['bearer']);
  } finally {
    await t.close();
  }
});

test('agent HTTP workflow claims ready work and completes with policy evidence', async () => {
  const t = await startTestServer();
  try {
    const ticket = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST',
      body: { type: 'story', title: 'Agent work', status: 'todo' },
    });
    const id = ticket.data.id;
    const contract = await apiFetch(t.baseUrl, `/api/agent/tickets/${id}/contract`, {
      method: 'PUT',
      body: {
        acceptance: ['tests pass'],
        policy: { requireVerification: true },
        __by: 'planner',
      },
    });
    assert.equal(contract.status, 200);

    const ready = await apiFetch(t.baseUrl, '/api/agent/ready');
    assert.ok(ready.data.some((item) => item.ticket.id === id));

    const claim = await apiFetch(t.baseUrl, '/api/agent/claim', {
      method: 'POST',
      body: { ticketId: id, agent: 'worker', files: ['src/a.js'] },
    });
    assert.equal(claim.status, 201);
    assert.equal(claim.data.lease.agent, 'worker');
    assert.equal(claim.data.ticket.status, 'in_progress');

    const context = await apiFetch(t.baseUrl, `/api/agent/tickets/${id}/context`);
    assert.equal(context.status, 200);
    assert.equal(context.data.ticket.id, id);
    assert.equal(context.data.readiness.state, 'claimed');
    assert.equal(context.data.execution.phase, 'running');

    const complete = await apiFetch(t.baseUrl, `/api/agent/tickets/${id}/complete`, {
      method: 'POST',
      body: {
        attemptId: claim.data.attempt.attemptId,
        agent: 'worker',
        verification: [{ command: 'npm test', ok: true }],
      },
    });
    assert.equal(complete.status, 200);
    assert.equal(complete.data.ticket.status, 'done');
  } finally {
    await t.close();
  }
});

test('agent HTTP exposes parallel planning, execution state, and durable handoff', async () => {
  const t = await startTestServer();
  try {
    const first = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST', body: { type: 'story', title: 'First child work', status: 'todo' },
    });
    const second = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST', body: { type: 'story', title: 'Second child work', status: 'todo' },
    });
    await apiFetch(t.baseUrl, `/api/agent/tickets/${first.data.id}/contract`, {
      method: 'PUT', body: { policy: { files: ['src/first.js'] }, __by: 'planner' },
    });
    await apiFetch(t.baseUrl, `/api/agent/tickets/${second.data.id}/contract`, {
      method: 'PUT', body: { policy: { files: ['src/second.js'] }, __by: 'planner' },
    });
    const plan = await apiFetch(t.baseUrl, '/api/agent/ready?plan=true');
    assert.equal(plan.status, 200);
    assert.ok(plan.data.parallelGroups.some((group) => group.safe
      && group.tickets.includes(first.data.id) && group.tickets.includes(second.data.id)));

    const claim = await apiFetch(t.baseUrl, '/api/agent/claim', {
      method: 'POST',
      body: { ticketId: first.data.id, agent: 'claude:child-1', files: ['src/first.js'] },
    });
    const board = await apiFetch(t.baseUrl, '/api/board');
    const activeTicket = Object.values(board.data.buckets).flat().find((item) => item.id === first.data.id);
    assert.equal(activeTicket.execution.phase, 'running');
    assert.equal(activeTicket.execution.agent, 'claude:child-1');

    await apiFetch(t.baseUrl, `/api/agent/tickets/${first.data.id}/discoveries`, {
      method: 'POST', body: { type: 'decision', body: 'Keep the boundary', author: 'claude:child-1' },
    });
    const handoff = await apiFetch(t.baseUrl, `/api/agent/tickets/${first.data.id}/handoffs`, {
      method: 'POST',
      body: {
        agent: 'claude:child-1', attemptId: claim.data.attempt.attemptId,
        summary: 'Ready for continuation', remaining: ['Run integration test'],
      },
    });
    assert.equal(handoff.status, 201);
    assert.equal(handoff.data.attempt.status, 'handed_off');
    assert.equal(handoff.data.data.decisions[0], 'Keep the boundary');
    const shown = await apiFetch(t.baseUrl, `/api/tickets/${first.data.id}`);
    assert.equal(shown.data.execution.phase, 'handed_off');
    assert.equal(shown.data.status, 'todo');
  } finally {
    await t.close();
  }
});

test('agent HTTP mailbox delivers pending messages, replies, acknowledgements, and wakeup SSE', async () => {
  const t = await startTestServer();
  const abort = new AbortController();
  try {
    for (const [id, provider] of [['codex:sol', 'openai'], ['claude:opus', 'anthropic']]) {
      const registered = await apiFetch(t.baseUrl, `/api/agent/agents/${encodeURIComponent(id)}`, {
        method: 'PUT', body: { displayName: id.split(':')[1], provider, capabilities: ['review'] },
      });
      assert.equal(registered.status, 200);
      assert.equal(registered.data.status, 'online');
    }
    bindSession({
      scopeDir: t.scope.scopeDir,
      agentId: 'claude:opus',
      provider: 'claude',
      sessionId: '22222222-2222-4222-8222-222222222222',
    });

    const sent = await apiFetch(t.baseUrl, '/api/agent/messages', {
      method: 'POST', body: {
        fromAgent: 'codex:sol', toAgent: 'claude:opus', kind: 'review_request', body: 'Review commit abc123',
      },
    });
    assert.equal(sent.status, 201);
    const overview = await apiFetch(t.baseUrl, '/api/agent/overview');
    assert.equal(overview.status, 200);
    const opus = overview.data.agents.find((agent) => agent.agentId === 'claude:opus');
    assert.equal(opus.pendingMessages, 1);
    assert.equal(opus.sessionBridge.bound, true);
    assert.equal(opus.sessionBridge.connected, false, 'a binding without a live runner is not connected');
    assert.equal(overview.data.agents.find((agent) => agent.agentId === 'codex:sol').sessionBridge.bound, false);
    assert.equal(overview.data.metrics.connectedSessions, 0);
    assert.equal(overview.data.metrics.activeLeases, 0);
    const inbox = await apiFetch(t.baseUrl, `/api/agent/agents/${encodeURIComponent('claude:opus')}/inbox`);
    assert.equal(inbox.data[0].messageId, sent.data.messageId);

    const stream = await fetch(`${t.baseUrl}/api/agent/agents/${encodeURIComponent('claude:opus')}/events`, {
      signal: abort.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    let text = '';
    while (!text.includes(sent.data.messageId)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    assert.match(text, /event: message/);
    assert.match(text, new RegExp(sent.data.messageId));
    abort.abort();

    const reply = await apiFetch(t.baseUrl, `/api/agent/messages/${sent.data.messageId}/replies`, {
      method: 'POST', body: { fromAgent: 'claude:opus', body: 'Reviewed; replay is sound.' },
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.data.toAgent, 'codex:sol');
    const conversation = await apiFetch(t.baseUrl,
      `/api/agent/conversations/${sent.data.threadId}?agent=${encodeURIComponent('codex:sol')}`);
    assert.equal(conversation.data.length, 2);
    const summaries = await apiFetch(t.baseUrl,
      `/api/agent/agents/${encodeURIComponent('codex:sol')}/conversations`);
    assert.equal(summaries.status, 200);
    assert.equal(summaries.data[0].threadId, sent.data.threadId);
    assert.equal(summaries.data[0].messageCount, 2);
    assert.equal(summaries.data[0].pendingCount, 1);

    const ack = await apiFetch(t.baseUrl, `/api/agent/messages/${sent.data.messageId}/ack`, {
      method: 'POST', body: { agent: 'claude:opus' },
    });
    assert.equal(ack.data.deliveryStatus, 'acknowledged');
    const empty = await apiFetch(t.baseUrl, `/api/agent/agents/${encodeURIComponent('claude:opus')}/inbox`);
    assert.deepEqual(empty.data, []);
  } finally {
    abort.abort();
    await t.close();
  }
});

test('GET /api/workspaces lists the attached test workspace', async () => {
  const t = await startTestServer();
  try {
    const { status, data } = await apiFetch(t.baseUrl, '/api/workspaces');
    assert.equal(status, 200);
    assert.equal(data.length, 1);
    assert.equal(data[0].id, t.workspaceId);
  } finally {
    await t.close();
  }
});

test('workspace + ticket happy path round-trips through HTTP', async () => {
  const t = await startTestServer();
  try {
    // v3: there's no POST /api/projects — the workspace is the project.
    // Update the singleton workspace via the workspaces endpoint.
    const wsUpdate = await apiFetch(t.baseUrl, `/api/workspaces/${t.workspaceId}`, {
      method: 'PATCH',
      body: { key: 'APP', name: 'My App' },
    });
    assert.equal(wsUpdate.status, 200);
    assert.equal(wsUpdate.data.key, 'APP');
    assert.equal(wsUpdate.data.name, 'My App');

    const epic = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST',
      body: { type: 'epic', title: 'Auth refactor', priority: 'high' },
    });
    assert.equal(epic.status, 201);
    assert.equal(epic.data.id, 'APP-1');
    assert.equal(epic.data.priority, 'high');

    const story = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST',
      body: { type: 'story', title: 'OAuth', parent: epic.data.id },
    });
    assert.equal(story.status, 201);
    assert.equal(story.data.parent_id, 'APP-1');

    const patched = await apiFetch(t.baseUrl, `/api/tickets/${story.data.id}`, {
      method: 'PATCH',
      body: { status: 'in_progress', __by: 'ui' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.status, 'in_progress');

    // The detail endpoint includes history (with author) and the patch above
    // should have recorded a 'status' change attributed to 'ui'.
    const detail = await apiFetch(t.baseUrl, `/api/tickets/${story.data.id}`);
    assert.equal(detail.status, 200);
    const statusChanges = detail.data.history.filter((h) => h.field === 'status');
    assert.equal(statusChanges.length, 1);
    assert.equal(statusChanges[0].new_value, 'in_progress');
    assert.equal(statusChanges[0].changed_by, 'ui');
  } finally {
    await t.close();
  }
});

test('SCP-243: PATCH rank reorders a column over HTTP and the board reflects it', async () => {
  const t = await startTestServer();
  try {
    // Three stories land in backlog in creation order (rank defaults to number).
    const ids = [];
    for (const title of ['First', 'Second', 'Third']) {
      const r = await apiFetch(t.baseUrl, '/api/tickets', {
        method: 'POST',
        body: { type: 'story', title },
      });
      assert.equal(r.status, 201);
      ids.push(r.data.id);
    }
    const [a, b, c] = ids;

    const order = async () => {
      const { data } = await apiFetch(t.baseUrl, '/api/board');
      return (data.buckets.backlog || []).map((tk) => tk.id);
    };
    assert.deepEqual(await order(), [a, b, c], 'default order is by number');

    // Drag the third card to the top: a fractional rank below the first.
    const patched = await apiFetch(t.baseUrl, `/api/tickets/${c}`, {
      method: 'PATCH',
      body: { rank: 0.5, __by: 'ui' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.rank, 0.5, 'the API accepts + echoes the new rank');
    assert.deepEqual(await order(), [c, a, b], 'board re-sorts by rank');

    // Drop it between the first two (midpoint of numbers 1 and 2).
    await apiFetch(t.baseUrl, `/api/tickets/${c}`, {
      method: 'PATCH',
      body: { rank: 1.5, __by: 'ui' },
    });
    assert.deepEqual(await order(), [a, c, b], 'a second reorder moves it again');

    // Reorders are cosmetic: no rank rows in the audit history.
    const detail = await apiFetch(t.baseUrl, `/api/tickets/${c}`);
    assert.equal(detail.data.history.filter((h) => h.field === 'rank').length, 0);
  } finally {
    await t.close();
  }
});

test('GET /api/tickets/:id returns 404 for missing tickets', async () => {
  const t = await startTestServer();
  try {
    const { status, data } = await apiFetch(t.baseUrl, '/api/tickets/APP-999');
    assert.equal(status, 404);
    assert.equal(data.error, 'not found');
  } finally {
    await t.close();
  }
});

test('POST /api/tickets rejects invalid input with 400', async () => {
  const t = await startTestServer();
  try {
    await apiFetch(t.baseUrl, '/api/projects', { method: 'POST', body: { id: 'a', key: 'A1', name: 'a' } });
    const r = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST',
      body: { projectIdOrKey: 'a', type: 'task', title: 'x' },
    });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Invalid type/);
  } finally {
    await t.close();
  }
});

test('relations endpoint adds the inverse and lists both sides', async () => {
  const t = await startTestServer();
  try {
    await apiFetch(t.baseUrl, '/api/projects', { method: 'POST', body: { id: 'a', key: 'A1', name: 'a' } });
    const a = (await apiFetch(t.baseUrl, '/api/tickets', { method: 'POST', body: { projectIdOrKey: 'a', type: 'story', title: 'a' } })).data;
    const b = (await apiFetch(t.baseUrl, '/api/tickets', { method: 'POST', body: { projectIdOrKey: 'a', type: 'story', title: 'b' } })).data;

    const added = await apiFetch(t.baseUrl, `/api/tickets/${a.id}/relations`, {
      method: 'POST',
      body: { to: b.id, type: 'blocks' },
    });
    assert.equal(added.status, 201);

    const fromA = await apiFetch(t.baseUrl, `/api/tickets/${a.id}/relations`);
    assert.equal(fromA.data[0].type, 'blocks');
    assert.equal(fromA.data[0].to_ticket_id, b.id);

    const fromB = await apiFetch(t.baseUrl, `/api/tickets/${b.id}/relations`);
    assert.equal(fromB.data[0].type, 'blocked_by');

    const removed = await apiFetch(t.baseUrl, `/api/tickets/${a.id}/relations`, {
      method: 'DELETE',
      body: { to: b.id, type: 'blocks' },
    });
    assert.equal(removed.status, 200);
    const after = await apiFetch(t.baseUrl, `/api/tickets/${a.id}/relations`);
    assert.equal(after.data.length, 0);
  } finally {
    await t.close();
  }
});

test('comments endpoint persists and lists comments', async () => {
  const t = await startTestServer();
  try {
    await apiFetch(t.baseUrl, '/api/projects', { method: 'POST', body: { id: 'a', key: 'A1', name: 'a' } });
    const tk = (await apiFetch(t.baseUrl, '/api/tickets', { method: 'POST', body: { projectIdOrKey: 'a', type: 'story', title: 'a' } })).data;
    const added = await apiFetch(t.baseUrl, `/api/tickets/${tk.id}/comments`, {
      method: 'POST',
      body: { body: 'first', author: 'me' },
    });
    assert.equal(added.status, 201);
    assert.equal(added.data.body, 'first');

    const list = await apiFetch(t.baseUrl, `/api/tickets/${tk.id}/comments`);
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].author, 'me');
  } finally {
    await t.close();
  }
});

test('board endpoint groups tickets into status buckets', async () => {
  const t = await startTestServer();
  try {
    await apiFetch(t.baseUrl, '/api/projects', { method: 'POST', body: { id: 'a', key: 'A1', name: 'a' } });
    const epic = (await apiFetch(t.baseUrl, '/api/tickets', { method: 'POST', body: { projectIdOrKey: 'a', type: 'epic', title: 'e' } })).data;
    const s1 = (await apiFetch(t.baseUrl, '/api/tickets', { method: 'POST', body: { projectIdOrKey: 'a', type: 'story', title: 's1', status: 'todo', parent: epic.id } })).data;
    const s2 = (await apiFetch(t.baseUrl, '/api/tickets', { method: 'POST', body: { projectIdOrKey: 'a', type: 'story', title: 's2', status: 'done', parent: epic.id } })).data;

    const board = await apiFetch(t.baseUrl, '/api/board?project=a');
    assert.equal(board.status, 200);
    assert.ok(board.data.columns.some((column) => column.id === 'done'));
    const inTodo = board.data.buckets.todo.map((t) => t.id);
    const inDone = board.data.buckets.done.map((t) => t.id);
    assert.ok(inTodo.includes(s1.id));
    assert.ok(inDone.includes(s2.id));

    // Filter by epic
    const filtered = await apiFetch(t.baseUrl, `/api/board?project=a&epic=${epic.id}`);
    const all = Object.values(filtered.data.buckets).flat().map((t) => t.id);
    assert.deepEqual(all.sort(), [s1.id, s2.id].sort());
  } finally {
    await t.close();
  }
});

test('GET /api/history returns workspace-scoped, newest-first entries with cursor pagination', async () => {
  const t = await startTestServer();
  try {
    const tk = (await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST', body: { type: 'story', title: 'x' },
    })).data;
    const other = (await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST', body: { type: 'story', title: 'y' },
    })).data;
    // Generate history rows.
    await apiFetch(t.baseUrl, `/api/tickets/${tk.id}`, { method: 'PATCH', body: { status: 'todo', __by: 'ui' } });
    await apiFetch(t.baseUrl, `/api/tickets/${tk.id}`, { method: 'PATCH', body: { status: 'in_progress', __by: 'agent' } });
    await apiFetch(t.baseUrl, `/api/tickets/${other.id}`, { method: 'PATCH', body: { status: 'todo', __by: 'ui' } });

    // v3: /api/history no longer requires ?project=. It resolves the
    // workspace via the standard resolveWs path (single attached workspace).
    const all = await apiFetch(t.baseUrl, '/api/history');
    assert.equal(all.status, 200);
    assert.ok(Array.isArray(all.data.entries));
    assert.equal(all.data.entries.length, 3);
    // Newest first.
    for (let i = 0; i < all.data.entries.length - 1; i++) {
      assert.ok(all.data.entries[i].changed_at >= all.data.entries[i + 1].changed_at);
    }
    // Ticket meta joined in.
    assert.ok(all.data.entries[0].ticket_title);
    assert.ok(all.data.entries[0].ticket_type);

    // Pagination via composite cursor (changed_at + id).
    const cursorRow = all.data.entries[0];
    const page = await apiFetch(
      t.baseUrl,
      `/api/history?before=${encodeURIComponent(cursorRow.changed_at)}&beforeId=${cursorRow.id}`,
    );
    assert.equal(page.status, 200);
    assert.equal(page.data.entries.length, all.data.entries.length - 1);
    assert.ok(page.data.entries.every((r) =>
      r.changed_at < cursorRow.changed_at ||
      (r.changed_at === cursorRow.changed_at && r.id < cursorRow.id)
    ));

    // Explicit workspace filter works too.
    const scoped = await apiFetch(t.baseUrl, `/api/history?workspace=${t.workspaceId}`);
    assert.equal(scoped.status, 200);
    assert.equal(scoped.data.entries.length, all.data.entries.length);

    // Limit clamp.
    const lim = await apiFetch(t.baseUrl, '/api/history?limit=1');
    assert.equal(lim.data.entries.length, 1);
  } finally {
    await t.close();
  }
});

test('DELETE /api/tickets/:id removes the ticket', async () => {
  const t = await startTestServer();
  try {
    await apiFetch(t.baseUrl, '/api/projects', { method: 'POST', body: { id: 'a', key: 'A1', name: 'a' } });
    const tk = (await apiFetch(t.baseUrl, '/api/tickets', { method: 'POST', body: { projectIdOrKey: 'a', type: 'story', title: 'x' } })).data;
    const del = await apiFetch(t.baseUrl, `/api/tickets/${tk.id}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const gone = await apiFetch(t.baseUrl, `/api/tickets/${tk.id}`);
    assert.equal(gone.status, 404);
  } finally {
    await t.close();
  }
});
