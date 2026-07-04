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
