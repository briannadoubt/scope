/**
 * scope-kanban — public library API.
 *
 * This module is the package's `.` entry point (see `exports` in package.json).
 * The supported surface is deliberately small: one runtime entry
 * ({@link openWorkspace}) plus the domain vocabulary as values. Everything is
 * reached through the workspace handle — there is one obvious way to do things,
 * and the SQLite/event-log machinery underneath stays private.
 *
 *     import { openWorkspace } from 'scope-kanban';
 *     const ws = openWorkspace();               // finds the nearest .scope/
 *     const epic = ws.createTicket({ type: 'epic', title: 'Auth refactor' });
 *     ws.updateTicket(epic.id, { status: 'in_progress' }, 'claude');
 *     ws.epicProgress(epic.id);                 // → { total, counts, done, percent }
 *     ws.close();
 *
 * `openWorkspace(dir)` mirrors exactly what the CLI does on each command (open
 * the SQLite cache, ensure the append-only event log, replay the log if it's
 * ahead of the cache), so writes persist to both the cache and the log just
 * like `scope ticket create` would.
 */

import {
  openDb,
  findScopeDir,
  defaultScopeDir,
  ensureScopeGitignore,
} from './db.js';
import { ensureEventLog } from './backfill.js';
import { syncFromLog } from './replay.js';
// Named imports (not `import * as repo` + string lookup): these are resolved at
// link time, so renaming any of them in repo.js fails loudly at module load
// instead of silently at first call, and IDE "rename symbol" tracks them.
import {
  applyBatch,
  getWorkspace,
  updateWorkspace,
  rekeyWorkspace,
  createTicket,
  getTicket,
  listTickets,
  searchTickets,
  updateTicket,
  deleteTicket,
  addRelation,
  removeRelation,
  listRelations,
  addComment,
  listComments,
  listHistory,
  listEpicChildren,
  epicProgress,
} from './repo.js';

/* ---------------- domain vocabulary ---------------- */

// The frozen enums the data model validates against, plus the default board
// columns — enough to build UIs and validate input without reaching into
// internals.
export {
  TICKET_TYPES,
  STATUSES,
  PRIORITIES,
  RELATION_TYPES,
} from './enums.js';
export { DEFAULT_COLUMNS } from './columns.js';

/* ---------------- stateful facade ---------------- */

/**
 * Open (or create) a scope workspace and return a handle with the data-layer
 * API bound to it. This is the one entry point — every operation hangs off the
 * returned handle.
 *
 * @param {string} [scopeDir] Path to the `.scope/` directory. Defaults to the
 *   nearest one at or above `process.cwd()`, then to `<cwd>/.scope`.
 * @returns A handle exposing `db`, `scopeDir`, `close()`, and the data-layer
 *   methods (`createTicket`, `updateTicket`, `listTickets`, …) with the
 *   underlying `db` pre-bound, so you call `ws.createTicket({...})` instead of
 *   `createTicket(db, {...})`.
 */
export function openWorkspace(scopeDir) {
  const dir = scopeDir ?? findScopeDir() ?? defaultScopeDir();
  const db = openDb(dir);
  ensureScopeGitignore(dir);
  ensureEventLog(db, dir);
  // Rebuild the cache if the on-disk log is ahead (e.g. after a git pull).
  syncFromLog(db, dir);

  // Each method forwards to the data-layer function with this workspace's `db`
  // bound as the first argument. Direct references (not string lookups) so a
  // rename in repo.js is a real, tool-visible break, not a stale string.
  const bind = (fn) => (...args) => fn(db, ...args);
  return {
    db,
    scopeDir: dir,
    close: () => db.close(),
    applyBatch: bind(applyBatch),
    getWorkspace: bind(getWorkspace),
    updateWorkspace: bind(updateWorkspace),
    rekeyWorkspace: bind(rekeyWorkspace),
    createTicket: bind(createTicket),
    getTicket: bind(getTicket),
    listTickets: bind(listTickets),
    searchTickets: bind(searchTickets),
    updateTicket: bind(updateTicket),
    deleteTicket: bind(deleteTicket),
    addRelation: bind(addRelation),
    removeRelation: bind(removeRelation),
    listRelations: bind(listRelations),
    addComment: bind(addComment),
    listComments: bind(listComments),
    listHistory: bind(listHistory),
    listEpicChildren: bind(listEpicChildren),
    epicProgress: bind(epicProgress),
  };
}
