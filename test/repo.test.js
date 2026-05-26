import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import {
  createProject, getProject, listProjects, updateProject, deleteProject,
  createTicket, getTicket, listTickets, updateTicket, deleteTicket,
  addRelation, removeRelation, listRelations,
  addComment, listComments, listHistory, listProjectHistory,
  listEpicChildren, epicProgress,
} from '../src/repo.js';

/* ---------------- projects ---------------- */

test('createProject rejects invalid ids and keys', () => {
  const { db, cleanup } = createTempScope();
  try {
    assert.throws(() => createProject(db, { id: 'Bad-Id', key: 'OK', name: 'x' }), /Invalid project id/);
    assert.throws(() => createProject(db, { id: 'ok', key: 'bad', name: 'x' }), /Invalid project key/);
    assert.throws(() => createProject(db, { id: 'ok', key: 'X', name: 'x' }), /Invalid project key/); // too short
    assert.throws(() => createProject(db, { id: 'ok', key: 'TOO_LONG_KEY_HERE', name: 'x' }), /Invalid project key/);
  } finally {
    cleanup();
  }
});

test('project CRUD round-trip', () => {
  const { db, cleanup } = createTempScope();
  try {
    const p = createProject(db, { id: 'app', key: 'APP', name: 'My App', description: 'a thing' });
    assert.equal(p.id, 'app');
    assert.equal(p.key, 'APP');
    assert.equal(p.description, 'a thing');

    // Lookup by id OR key.
    assert.equal(getProject(db, 'app').id, 'app');
    assert.equal(getProject(db, 'APP').id, 'app');

    const updated = updateProject(db, 'app', { name: 'Renamed', description: 'new desc' });
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.description, 'new desc');

    assert.equal(listProjects(db).length, 1);

    assert.equal(deleteProject(db, 'app'), true);
    assert.equal(deleteProject(db, 'app'), false); // already gone
    assert.equal(getProject(db, 'app'), undefined);
  } finally {
    cleanup();
  }
});

/* ---------------- tickets ---------------- */

function seed(db) {
  createProject(db, { id: 'app', key: 'APP', name: 'App' });
  const epic = createTicket(db, { projectIdOrKey: 'app', type: 'epic', title: 'Auth' });
  return { epic };
}

test('createTicket validates inputs', () => {
  const { db, cleanup } = createTempScope();
  try {
    seed(db);
    assert.throws(() => createTicket(db, { projectIdOrKey: 'app', type: 'task', title: 'x' }), /Invalid type/);
    assert.throws(() => createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'x', status: 'bogus' }), /Invalid status/);
    assert.throws(() => createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'x', priority: 'bogus' }), /Invalid priority/);
    assert.throws(() => createTicket(db, { projectIdOrKey: 'app', type: 'story', title: '   ' }), /title is required/);
    assert.throws(() => createTicket(db, { projectIdOrKey: 'nope', type: 'story', title: 'x' }), /Project not found/);
  } finally {
    cleanup();
  }
});

test('createTicket enforces parent rules: only epics can be parents, same project, no epic-of-epic', () => {
  const { db, cleanup } = createTempScope();
  try {
    const { epic } = seed(db);
    // Non-existent parent
    assert.throws(
      () => createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'x', parent: 'APP-999' }),
      /Parent ticket not found/,
    );
    // Story as parent
    const story = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'a story' });
    assert.throws(
      () => createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'x', parent: story.id }),
      /Parent must be an epic/,
    );
    // Epic with an epic parent
    assert.throws(
      () => createTicket(db, { projectIdOrKey: 'app', type: 'epic', title: 'sub-epic', parent: epic.id }),
      /Epics cannot have an epic parent/,
    );
    // Happy path
    const child = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'real child', parent: epic.id });
    assert.equal(child.parent_id, epic.id);
  } finally {
    cleanup();
  }
});

test('createTicket hydrates labels as a real array', () => {
  const { db, cleanup } = createTempScope();
  try {
    seed(db);
    const t = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'x', labels: ['ui', 'p1'] });
    assert.deepEqual(t.labels, ['ui', 'p1']);
    const fetched = getTicket(db, t.id);
    assert.deepEqual(fetched.labels, ['ui', 'p1']);
  } finally {
    cleanup();
  }
});

test('listTickets filters and orders by number', () => {
  const { db, cleanup } = createTempScope();
  try {
    const { epic } = seed(db);
    const s1 = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 's1', parent: epic.id, status: 'todo' });
    const s2 = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 's2', status: 'done', assignee: 'bri' });
    const b1 = createTicket(db, { projectIdOrKey: 'app', type: 'bug', title: 'b1', parent: epic.id });

    assert.equal(listTickets(db).length, 4);
    assert.equal(listTickets(db, { type: 'bug' }).length, 1);
    assert.equal(listTickets(db, { status: 'done' })[0].id, s2.id);
    assert.equal(listTickets(db, { assignee: 'bri' })[0].id, s2.id);
    assert.equal(listTickets(db, { parentId: epic.id }).length, 2);
    assert.equal(listTickets(db, { parentId: null }).length, 2); // the epic itself + s2
    assert.equal(listTickets(db, { projectIdOrKey: 'missing' }).length, 0);

    // Order: project_id, number
    const ids = listTickets(db).map((t) => t.id);
    assert.deepEqual(ids, [epic.id, s1.id, s2.id, b1.id]);
  } finally {
    cleanup();
  }
});

test('updateTicket records history per changed field and refuses bad parent moves', () => {
  const { db, cleanup } = createTempScope();
  try {
    const { epic } = seed(db);
    const story = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 's1' });

    const after = updateTicket(db, story.id, { status: 'in_progress', priority: 'high' }, 'me');
    assert.equal(after.status, 'in_progress');
    assert.equal(after.priority, 'high');

    const hist = listHistory(db, story.id);
    const fields = new Set(hist.map((h) => h.field));
    assert.ok(fields.has('status'));
    assert.ok(fields.has('priority'));
    for (const h of hist) assert.equal(h.changed_by, 'me');

    // No-op update returns the ticket unchanged
    const noop = updateTicket(db, story.id, {});
    assert.equal(noop.id, story.id);

    // Bad status / priority
    assert.throws(() => updateTicket(db, story.id, { status: 'bogus' }), /Invalid status/);
    assert.throws(() => updateTicket(db, story.id, { priority: 'bogus' }), /Invalid priority/);

    // Self-parent
    const epic2 = createTicket(db, { projectIdOrKey: 'app', type: 'epic', title: 'e2' });
    assert.throws(() => updateTicket(db, epic2.id, { parent_id: epic2.id }), /cannot be its own parent|Epics cannot have a parent/);

    // Move story under epic
    const moved = updateTicket(db, story.id, { parent_id: epic.id });
    assert.equal(moved.parent_id, epic.id);

    // Non-epic parent
    const other = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'other' });
    assert.throws(() => updateTicket(db, story.id, { parent_id: other.id }), /Parent must be an epic/);

    // Cross-project parent
    createProject(db, { id: 'other', key: 'OTH', name: 'O' });
    const otherEpic = createTicket(db, { projectIdOrKey: 'other', type: 'epic', title: 'oe' });
    assert.throws(() => updateTicket(db, story.id, { parent_id: otherEpic.id }), /same project/);
  } finally {
    cleanup();
  }
});

test('deleteTicket removes the row and is idempotent', () => {
  const { db, cleanup } = createTempScope();
  try {
    seed(db);
    const t = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'x' });
    assert.equal(deleteTicket(db, t.id), true);
    assert.equal(deleteTicket(db, t.id), false);
    assert.equal(getTicket(db, t.id), null);
  } finally {
    cleanup();
  }
});

test('deleting an epic detaches its children (ON DELETE SET NULL)', () => {
  const { db, cleanup } = createTempScope();
  try {
    const { epic } = seed(db);
    const child = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'c', parent: epic.id });
    deleteTicket(db, epic.id);
    const orphan = getTicket(db, child.id);
    assert.equal(orphan.parent_id, null);
  } finally {
    cleanup();
  }
});

/* ---------------- relations ---------------- */

test('addRelation creates the inverse and is idempotent', () => {
  const { db, cleanup } = createTempScope();
  try {
    seed(db);
    const a = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'a' });
    const b = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'b' });

    addRelation(db, a.id, b.id, 'blocks');
    const aRels = listRelations(db, a.id);
    const bRels = listRelations(db, b.id);
    assert.equal(aRels.length, 1);
    assert.equal(aRels[0].type, 'blocks');
    assert.equal(aRels[0].to_ticket_id, b.id);
    assert.equal(bRels.length, 1);
    assert.equal(bRels[0].type, 'blocked_by');

    // Idempotent — second call doesn't double-insert.
    addRelation(db, a.id, b.id, 'blocks');
    assert.equal(listRelations(db, a.id).length, 1);
  } finally {
    cleanup();
  }
});

test('addRelation rejects self-references and unknown types', () => {
  const { db, cleanup } = createTempScope();
  try {
    seed(db);
    const a = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'a' });
    assert.throws(() => addRelation(db, a.id, a.id, 'blocks'), /relate a ticket to itself/);
    assert.throws(() => addRelation(db, a.id, a.id, 'cousin_of'), /Invalid relation type/);
  } finally {
    cleanup();
  }
});

test('removeRelation tears down both sides', () => {
  const { db, cleanup } = createTempScope();
  try {
    seed(db);
    const a = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'a' });
    const b = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'b' });
    addRelation(db, a.id, b.id, 'duplicates');
    removeRelation(db, a.id, b.id, 'duplicates');
    assert.equal(listRelations(db, a.id).length, 0);
    assert.equal(listRelations(db, b.id).length, 0);
  } finally {
    cleanup();
  }
});

/* ---------------- comments ---------------- */

test('comments persist in insertion order', async () => {
  const { db, cleanup } = createTempScope();
  try {
    seed(db);
    const t = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'x' });
    addComment(db, t.id, 'first', 'a');
    // The schema stores created_at to ms precision; nudge so the second one
    // sorts strictly after the first when read back.
    await new Promise((r) => setTimeout(r, 5));
    addComment(db, t.id, 'second', 'b');
    const got = listComments(db, t.id);
    assert.equal(got.length, 2);
    assert.equal(got[0].body, 'first');
    assert.equal(got[1].body, 'second');
  } finally {
    cleanup();
  }
});

test('addComment errors when the ticket is unknown', () => {
  const { db, cleanup } = createTempScope();
  try {
    seed(db);
    assert.throws(() => addComment(db, 'APP-999', 'x'), /Ticket not found/);
  } finally {
    cleanup();
  }
});

/* ---------------- epic progress ---------------- */

test('epicProgress counts children by status and reports percent done', () => {
  const { db, cleanup } = createTempScope();
  try {
    const { epic } = seed(db);
    createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'a', parent: epic.id, status: 'done' });
    createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'b', parent: epic.id, status: 'done' });
    createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'c', parent: epic.id, status: 'in_progress' });
    createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'd', parent: epic.id, status: 'todo' });

    const p = epicProgress(db, epic.id);
    assert.equal(p.total, 4);
    assert.equal(p.done, 2);
    assert.equal(p.percent, 50);
    assert.equal(p.counts.done, 2);
    assert.equal(p.counts.todo, 1);
    assert.equal(p.counts.in_progress, 1);

    // Empty epic
    const empty = createTicket(db, { projectIdOrKey: 'app', type: 'epic', title: 'empty' });
    const ep = epicProgress(db, empty.id);
    assert.equal(ep.total, 0);
    assert.equal(ep.percent, 0);
  } finally {
    cleanup();
  }
});

test('listProjectHistory returns rows newest-first, joined with ticket meta, and paginates via before=', () => {
  const { db, cleanup } = createTempScope();
  try {
    createProject(db, { id: 'app', key: 'APP', name: 'App' });
    createProject(db, { id: 'other', key: 'OTH', name: 'Other' });
    const t1 = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'first' });
    const t2 = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'second' });
    const tOther = createTicket(db, { projectIdOrKey: 'other', type: 'story', title: 'unrelated' });

    // Make a handful of history rows across both projects.
    updateTicket(db, t1.id, { status: 'todo' }, 'ui');
    updateTicket(db, t1.id, { status: 'in_progress' }, 'agent');
    updateTicket(db, t2.id, { priority: 'high' }, 'cli');
    updateTicket(db, tOther.id, { status: 'todo' }, 'ui');

    const all = listProjectHistory(db, 'app');
    // Other project's row must be excluded.
    assert.ok(all.every((r) => r.ticket_id === t1.id || r.ticket_id === t2.id));
    assert.equal(all.length, 3);
    // Newest first.
    for (let i = 0; i < all.length - 1; i++) {
      assert.ok(all[i].changed_at >= all[i + 1].changed_at);
    }
    // Joined ticket meta.
    const sample = all[0];
    assert.ok(sample.ticket_title);
    assert.ok(sample.ticket_type);
    assert.ok(sample.field);

    // Limit honored + clamped to [1, 500].
    assert.equal(listProjectHistory(db, 'app', { limit: 1 }).length, 1);
    assert.equal(listProjectHistory(db, 'app', { limit: 99999 }).length, 3);
    assert.equal(listProjectHistory(db, 'app', { limit: 0 }).length, 1);

    // Cursor: before=(changed_at,id) returns only strictly-older rows under
    // the composite (changed_at DESC, id DESC) ordering. Pass the row's id
    // as a tiebreaker because rapid updates often share a millisecond.
    const cursorRow = all[0];
    const older = listProjectHistory(db, 'app', {
      before: cursorRow.changed_at,
      beforeId: cursorRow.id,
    });
    assert.equal(older.length, all.length - 1);
    assert.ok(older.every((r) =>
      r.changed_at < cursorRow.changed_at ||
      (r.changed_at === cursorRow.changed_at && r.id < cursorRow.id)
    ));

    // Unknown project throws.
    assert.throws(() => listProjectHistory(db, 'nope'), /Project not found/);
  } finally {
    cleanup();
  }
});

test('listEpicChildren returns only direct children, ordered', () => {
  const { db, cleanup } = createTempScope();
  try {
    const { epic } = seed(db);
    const s = createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 's', parent: epic.id });
    const b = createTicket(db, { projectIdOrKey: 'app', type: 'bug', title: 'b', parent: epic.id });
    const otherEpic = createTicket(db, { projectIdOrKey: 'app', type: 'epic', title: 'other' });
    createTicket(db, { projectIdOrKey: 'app', type: 'story', title: 'orphan' }); // unrelated

    const children = listEpicChildren(db, epic.id);
    const ids = children.map((c) => c.id).sort();
    assert.deepEqual(ids, [b.id, s.id].sort());
    assert.equal(listEpicChildren(db, otherEpic.id).length, 0);
  } finally {
    cleanup();
  }
});
