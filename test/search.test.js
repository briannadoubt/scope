import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope, startTestServer, apiFetch } from './helpers.js';
import { ensureSearchIndex } from '../src/db.js';
import {
  createTicket,
  updateTicket,
  deleteTicket,
  addComment,
  searchTickets,
} from '../src/repo.js';

const ids = (rows) => rows.map((t) => t.id);

/* ---------------- field coverage ---------------- */

test('searchTickets matches across every ticket field', () => {
  const { db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, {
      type: 'story',
      title: 'Quokka authentication',
      description: 'Refactor the login flow for marsupials',
      assignee: 'brianna',
      labels: ['security', 'backend'],
      branch: 'feature/quokka-auth',
      prUrl: 'https://github.com/acme/repo/pull/4242',
    });
    addComment(db, t.id, 'Looks good, ship it after the audit', 'reviewer');

    // title
    assert.deepEqual(ids(searchTickets(db, 'quokka')), [t.id]);
    // description
    assert.deepEqual(ids(searchTickets(db, 'marsupials')), [t.id]);
    // assignee
    assert.deepEqual(ids(searchTickets(db, 'brianna')), [t.id]);
    // label
    assert.deepEqual(ids(searchTickets(db, 'security')), [t.id]);
    // branch
    assert.deepEqual(ids(searchTickets(db, 'feature')), [t.id]);
    // pr url fragment
    assert.deepEqual(ids(searchTickets(db, '4242')), [t.id]);
    // comment body + author
    assert.deepEqual(ids(searchTickets(db, 'audit')), [t.id]);
    assert.deepEqual(ids(searchTickets(db, 'reviewer')), [t.id]);
    // ticket key + number
    assert.deepEqual(ids(searchTickets(db, t.id)), [t.id]);
    assert.deepEqual(ids(searchTickets(db, String(t.number))), [t.id]);
  } finally {
    cleanup();
  }
});

test('an exact key / number query floats that ticket to the top', () => {
  const { db, cleanup } = createTempScope();
  try {
    // Create enough tickets that prefix siblings exist: e.g. T-1 and T-10+.
    let target = null;
    let sibling = null;
    for (let i = 0; i < 12; i++) {
      const t = createTicket(db, { type: 'story', title: `ticket ${i}` });
      if (t.number === 1) target = t;
      if (t.number === 10) sibling = t;
    }
    assert.ok(target && sibling, 'expected tickets numbered 1 and 10');

    // Bare number: "1" prefix-matches 1, 10, 11, … but the exact #1 must lead.
    const byNumber = searchTickets(db, String(target.number));
    assert.equal(byNumber[0].id, target.id, 'exact number leads');
    assert.ok(byNumber.some((t) => t.id === sibling.id), 'prefix siblings still present');

    // Exact key, case-insensitive.
    const byKey = searchTickets(db, target.id.toLowerCase());
    assert.equal(byKey[0].id, target.id, 'exact key leads (case-insensitive)');
  } finally {
    cleanup();
  }
});

test('non-ASCII numeric/symbol-only queries return [] rather than zeroing a real query', () => {
  const { db, cleanup } = createTempScope();
  try {
    createTicket(db, { type: 'story', title: 'normal ticket' });
    // unicode61 drops these, and so does buildFtsMatch — no token, no results,
    // and (critically) they can't turn into a no-match AND term.
    for (const q of ['٧', '½', '²', 'ⅷ']) {
      assert.deepEqual(searchTickets(db, q), [], `"${q}" → []`);
    }
    // Unicode letters still tokenize (diacritics folded by the tokenizer).
    const accented = createTicket(db, { type: 'story', title: 'café déjà' });
    assert.deepEqual(ids(searchTickets(db, 'cafe')), [accented.id]);
  } finally {
    cleanup();
  }
});

test('searchTickets does prefix matching as you type', () => {
  const { db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'bug', title: 'Authentication regression' });
    for (const partial of ['auth', 'authen', 'authentication']) {
      assert.deepEqual(ids(searchTickets(db, partial)), [t.id], `prefix "${partial}"`);
    }
  } finally {
    cleanup();
  }
});

test('searchTickets requires all tokens (implicit AND)', () => {
  const { db, cleanup } = createTempScope();
  try {
    const both = createTicket(db, { type: 'story', title: 'Fast login flow' });
    createTicket(db, { type: 'story', title: 'Fast checkout' });
    // "fast login" must match both tokens — only the first ticket qualifies.
    assert.deepEqual(ids(searchTickets(db, 'fast login')), [both.id]);
  } finally {
    cleanup();
  }
});

test('searchTickets returns [] for empty / token-less queries', () => {
  const { db, cleanup } = createTempScope();
  try {
    createTicket(db, { type: 'story', title: 'anything' });
    assert.deepEqual(searchTickets(db, ''), []);
    assert.deepEqual(searchTickets(db, '   '), []);
    assert.deepEqual(searchTickets(db, '-/.'), []);
    assert.deepEqual(searchTickets(db, null), []);
  } finally {
    cleanup();
  }
});

test('searchTickets ranks denser matches first (bm25)', () => {
  const { db, cleanup } = createTempScope();
  try {
    // "alpha" appears in title, description and a comment.
    const dense = createTicket(db, {
      type: 'story',
      title: 'alpha alpha',
      description: 'alpha release notes',
    });
    addComment(db, dense.id, 'alpha looks ready', 'qa');
    // "alpha" appears only once, buried in the description.
    const sparse = createTicket(db, {
      type: 'story',
      title: 'unrelated title',
      description: 'mentions alpha once',
    });

    const results = ids(searchTickets(db, 'alpha'));
    assert.equal(results.length, 2);
    assert.equal(results[0], dense.id, 'denser match should rank first');
    assert.ok(results.includes(sparse.id));
  } finally {
    cleanup();
  }
});

test('searchTickets respects the limit (clamped 1..200)', () => {
  const { db, cleanup } = createTempScope();
  try {
    for (let i = 0; i < 5; i++) {
      createTicket(db, { type: 'story', title: `widget number ${i}` });
    }
    assert.equal(searchTickets(db, 'widget', { limit: 2 }).length, 2);
    assert.equal(searchTickets(db, 'widget', { limit: -5 }).length, 1);   // clamped up to 1
    assert.equal(searchTickets(db, 'widget', { limit: 0 }).length, 1);    // 0 clamps to 1, not default
    assert.equal(searchTickets(db, 'widget', { limit: undefined }).length, 5); // absent → default
    assert.equal(searchTickets(db, 'widget', { limit: ['2', '4'] }).length, 2); // array → first
  } finally {
    cleanup();
  }
});

/* ---------------- index maintenance (triggers) ---------------- */

test('the FTS index follows ticket edits and deletes', () => {
  const { db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'bug', title: 'flibberty' });
    assert.deepEqual(ids(searchTickets(db, 'flibberty')), [t.id]);

    updateTicket(db, t.id, { title: 'gibberish' });
    assert.deepEqual(searchTickets(db, 'flibberty'), [], 'old title no longer matches');
    assert.deepEqual(ids(searchTickets(db, 'gibberish')), [t.id], 'new title matches');

    deleteTicket(db, t.id);
    assert.deepEqual(searchTickets(db, 'gibberish'), [], 'deleted ticket leaves the index');
  } finally {
    cleanup();
  }
});

test('the FTS index follows comment add and delete', () => {
  const { db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'story', title: 'parent ticket' });
    assert.deepEqual(searchTickets(db, 'zonktastic'), []);

    const c = addComment(db, t.id, 'totally zonktastic idea', 'pat');
    assert.deepEqual(ids(searchTickets(db, 'zonktastic')), [t.id]);

    // No repo-level comment delete exists; exercise the trigger directly.
    db.prepare('DELETE FROM ticket_comments WHERE id = ?').run(c.id);
    assert.deepEqual(searchTickets(db, 'zonktastic'), [], 'deleted comment leaves the index');
  } finally {
    cleanup();
  }
});

test('ensureSearchIndex rebuilds the index from existing rows when empty', () => {
  const { db, cleanup } = createTempScope();
  try {
    const t = createTicket(db, { type: 'story', title: 'rebuildable' });
    addComment(db, t.id, 'with a comment', 'me');

    // Simulate a missing/cleared index (e.g. first open after upgrade).
    db.exec('DELETE FROM tickets_fts');
    assert.deepEqual(searchTickets(db, 'rebuildable'), []);

    ensureSearchIndex(db);
    assert.deepEqual(ids(searchTickets(db, 'rebuildable')), [t.id]);
    assert.deepEqual(ids(searchTickets(db, 'comment')), [t.id], 'comments backfilled too');
  } finally {
    cleanup();
  }
});

/* ---------------- HTTP endpoint ---------------- */

test('GET /api/tickets/search returns ranked matches and is not shadowed by :id', async () => {
  const t = await startTestServer();
  try {
    const created = await apiFetch(t.baseUrl, '/api/tickets', {
      method: 'POST',
      headers: { 'X-Scope-Workspace': t.workspaceId },
      body: { type: 'story', title: 'Searchable kumquat', assignee: 'dana' },
    });
    assert.equal(created.status, 201);
    const id = created.data.id;

    const byTitle = await apiFetch(
      t.baseUrl,
      `/api/tickets/search?q=kumquat&workspace=${t.workspaceId}`
    );
    assert.equal(byTitle.status, 200);
    assert.deepEqual(byTitle.data.map((x) => x.id), [id]);

    const byAssignee = await apiFetch(
      t.baseUrl,
      `/api/tickets/search?q=dana&workspace=${t.workspaceId}`
    );
    assert.deepEqual(byAssignee.data.map((x) => x.id), [id]);

    // Empty query → empty array, not a 404 from the :id route.
    const empty = await apiFetch(
      t.baseUrl,
      `/api/tickets/search?q=&workspace=${t.workspaceId}`
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.data, []);
  } finally {
    await t.close();
  }
});
