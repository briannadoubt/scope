import test from 'node:test';
import assert from 'node:assert/strict';

import { createTempScope } from './helpers.js';
import { openDb } from '../src/db.js';
import { readAllEvents, eventsDir } from '../src/event-store.js';
import { replayInto } from '../src/replay.js';
import {
  createTicket,
  addRelation,
  rekeyWorkspace,
  updateWorkspace,
  listTickets,
  listRelations,
  getWorkspace,
} from '../src/repo.js';

test('rekey reprefixes every ticket and follows through parents and relations', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    updateWorkspace(db, { key: 'RT' });
    const epic = createTicket(db, { type: 'epic', title: 'E' });
    const a = createTicket(db, { type: 'story', title: 'A', parent: epic.id });
    const b = createTicket(db, { type: 'story', title: 'B' });
    addRelation(db, a.id, b.id, 'blocks', 'bri');
    assert.ok(epic.id.startsWith('RT-'));

    const r = rekeyWorkspace(db, 'ONE', { actor: 'bri' });
    assert.equal(r.key, 'ONE');
    assert.equal(r.reprefixed, 3);

    const tickets = listTickets(db);
    assert.ok(tickets.every((t) => t.id.startsWith('ONE-')), 'all ids reprefixed');
    assert.equal(getWorkspace(db).key, 'ONE');

    // Numbers preserved, parent pointer rewritten to the new prefix.
    const newEpic = tickets.find((t) => t.title === 'E');
    const newA = tickets.find((t) => t.title === 'A');
    assert.equal(newA.parent_id, newEpic.id);
    assert.equal(newEpic.id, `ONE-${epic.number}`);

    // Relation survives under new ids.
    const rels = listRelations(db, newA.id);
    assert.ok(rels.some((x) => x.type === 'blocks' && x.to_ticket_id.startsWith('ONE-')));
  } finally {
    cleanup();
  }
});

test('rekey is durable: replaying the log from scratch yields the reprefixed board', () => {
  const { scopeDir, db, cleanup } = createTempScope();
  try {
    createTicket(db, { type: 'story', title: 'X' });
    createTicket(db, { type: 'story', title: 'Y' });
    rekeyWorkspace(db, 'NEW', { actor: 'bri' });

    const fresh = createTempScope();
    try {
      replayInto(fresh.db, readAllEvents(eventsDir(scopeDir)));
      const ids = listTickets(fresh.db).map((t) => t.id).sort();
      assert.deepEqual(ids, ['NEW-1', 'NEW-2']);
      assert.equal(getWorkspace(fresh.db).key, 'NEW');
    } finally {
      fresh.cleanup();
    }
  } finally {
    cleanup();
  }
});

test('rekey rejects an invalid key and changes nothing', () => {
  const { db, cleanup } = createTempScope();
  try {
    createTicket(db, { type: 'story', title: 'X' });
    const before = listTickets(db)[0].id;
    assert.throws(() => rekeyWorkspace(db, 'bad-key'), /Invalid key/);
    assert.equal(listTickets(db)[0].id, before, 'unchanged after rejected rekey');
  } finally {
    cleanup();
  }
});
