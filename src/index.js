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

import { existsSync } from 'node:fs';
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
 * Open a scope workspace and return a handle with the data-layer API bound to
 * it. This is the one entry point — every operation hangs off the returned
 * handle.
 *
 * Opening never creates a workspace implicitly: if none is found the call
 * throws, mirroring the CLI (which requires `scope init`). This keeps library
 * writes from landing in an accidental board — e.g. when run from the wrong
 * directory, or when `SCOPE_DIR` is missing or typoed. Pass `{ create: true }`
 * to opt into creating the workspace when it doesn't exist yet.
 *
 * @param {string} [scopeDir] Path to the `.scope/` directory. Defaults to the
 *   nearest existing one at or above `process.cwd()` (honoring `SCOPE_DIR`).
 * @param {{ create?: boolean }} [opts]
 * @param {boolean} [opts.create=false] Create the workspace if it doesn't
 *   exist. When set with no `scopeDir`, creates at `SCOPE_DIR` or `<cwd>/.scope`.
 * @returns A handle exposing `scopeDir`, `close()`, and the data-layer methods
 *   (`createTicket`, `updateTicket`, `listTickets`, …) with the underlying `db`
 *   pre-bound, so you call `ws.createTicket({...})` instead of
 *   `createTicket(db, {...})`. The raw `db` handle is intentionally not exposed
 *   — writing to it directly would bypass the event log and be lost on the next
 *   cache rebuild.
 * @throws {Error} If no workspace is found and `create` is not set.
 */
export function openWorkspace(scopeDir, { create = false } = {}) {
  const dir = scopeDir ?? findScopeDir();
  if (dir && existsSync(dir)) return openAt(dir);
  if (!create) {
    const where = scopeDir
      ? `at "${scopeDir}"`
      : 'at or above the current directory';
    throw new Error(
      `No .scope/ workspace found ${where}. Run \`scope init\`, pass the path ` +
        `to an existing workspace, or call openWorkspace(dir, { create: true }).`
    );
  }
  return openAt(scopeDir ?? defaultScopeDir());
}

/**
 * Open (and, if absent, materialize) the workspace at `dir`, wiring the event
 * log the same way the CLI does on every command, and return the bound handle.
 */
function openAt(dir) {
  const db = openDb(dir);
  ensureScopeGitignore(dir);
  ensureEventLog(db, dir);
  // Rebuild the cache if the on-disk log is ahead (e.g. after a git pull).
  syncFromLog(db, dir);

  // Each method forwards to the data-layer function with this workspace's `db`
  // bound as the first argument. Direct references (not string lookups) so a
  // rename in repo.js is a real, tool-visible break, not a stale string. `db`
  // is kept in this closure and deliberately not exposed on the handle.
  const bind = (fn) => (...args) => fn(db, ...args);
  return {
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
