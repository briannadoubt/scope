import test from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, apiFetch } from './helpers.js';

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
    // SCP-57: security descriptor advertised on the API too (TXT and meta
    // carry the same info for clients that discover via different paths).
    assert.equal(data.security.scheme, 'http'); // tls:false in test helper
    assert.deepEqual(data.security.auth, ['bearer']);
  } finally {
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

test('project + ticket happy path round-trips through HTTP', async () => {
  const t = await startTestServer();
  try {
    const create = await apiFetch(t.baseUrl, '/api/projects', {
      method: 'POST',
      body: { id: 'app', key: 'APP', name: 'My App' },
    });
    assert.equal(create.status, 201);
    assert.equal(create.data.id, 'app');

    const get = await apiFetch(t.baseUrl, '/api/projects/app');
    assert.equal(get.status, 200);
    assert.equal(get.data.key, 'APP');
    assert.deepEqual(get.data.tickets, []);
    assert.deepEqual(get.data.epics, []);

    const epic = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST',
      body: { projectIdOrKey: 'app', type: 'epic', title: 'Auth refactor', priority: 'high' },
    });
    assert.equal(epic.status, 201);
    assert.equal(epic.data.id, 'APP-1');
    assert.equal(epic.data.priority, 'high');

    const story = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST',
      body: { projectIdOrKey: 'app', type: 'story', title: 'OAuth', parent: epic.data.id },
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
    assert.ok(board.data.columns.includes('done'));
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
