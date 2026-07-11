/**
 * scope-kanban — public library API.
 *
 * This module is the package's `.` entry point (see `exports` in package.json).
 * Everything re-exported here is part of the supported, semver-guarded surface;
 * anything imported via a deep path (`scope-kanban/src/...`) is private and may
 * change or move without a major bump.
 *
 * Two ways to use it:
 *
 *   1. The `openWorkspace(dir)` facade — a stateful handle with `db` bound into
 *      every method. This mirrors exactly what the CLI does on each command
 *      (open the SQLite cache, ensure the append-only event log exists, replay
 *      the log if it's ahead of the cache), so writes persist to both the cache
 *      and the log just like `scope ticket create` would.
 *
 *        import { openWorkspace } from 'scope-kanban';
 *        const ws = openWorkspace();               // finds the nearest .scope/
 *        const epic = ws.createTicket({ type: 'epic', title: 'Auth refactor' });
 *        ws.updateTicket(epic.id, { status: 'in_progress' }, 'claude');
 *        ws.close();
 *
 *   2. The raw functional API — the same `repo.js` / `db.js` functions the
 *      facade wraps, taking an explicit `db` handle as the first argument. Use
 *      this when you want to manage the `better-sqlite3` handle yourself.
 *
 *        import { openDb, createTicket } from 'scope-kanban';
 *        const db = openDb('/path/to/.scope');
 *        createTicket(db, { type: 'bug', title: 'CSRF on /signup' });
 */

import {
  openDb,
  findScopeDir,
  defaultScopeDir,
  ensureScopeGitignore,
} from './db.js';
import { ensureEventLog } from './backfill.js';
import { syncFromLog } from './replay.js';
import * as repo from './repo.js';

/* ---------------- raw functional API ---------------- */

// Data layer — every function takes a `db` handle (from `openDb`) as its first
// argument and persists to both the SQLite cache and the append-only log.
export {
  applyBatch,
  getWorkspace,
  setWorkspace,
  listWorkspaces,
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
  listWorkspaceHistory,
  listEpicChildren,
  epicSubtreeIds,
  listEpicDescendants,
  epicProgress,
  SEARCH_DEFAULT_LIMIT,
} from './repo.js';

// Storage primitives — open/locate a workspace database directly.
export {
  openDb,
  findScopeDir,
  defaultScopeDir,
  ensureScopeGitignore,
  SCOPE_DIR_NAME,
  DB_FILE_NAME,
} from './db.js';

// Vocabulary — the frozen enums the data model validates against.
export {
  TICKET_TYPES,
  STATUSES,
  PRIORITIES,
  RELATION_TYPES,
  RELATION_INVERSE,
  TICKET_FIELDS,
} from './enums.js';

// Board columns — normalize / classify a workspace's configurable statuses.
export {
  COLUMN_KINDS,
  DEFAULT_COLUMNS,
  normalizeColumns,
  parseColumns,
  statusIds,
  openColumns,
  terminalColumns,
  doneColumnIds,
} from './columns.js';

/* ---------------- CLI embedding ---------------- */

// For consumers that want to drive the CLI programmatically rather than shell
// out to the `scope` binary.
export { run, buildProgram } from './cli.js';

/* ---------------- stateful facade ---------------- */

// Repo functions that take `(db, ...rest)` and should be surfaced as workspace
// methods with `db` bound. Kept as a name list so the facade stays in lockstep
// with the re-exports above without hand-maintaining a wrapper per method.
const REPO_METHODS = [
  'applyBatch',
  'getWorkspace',
  'setWorkspace',
  'listWorkspaces',
  'updateWorkspace',
  'rekeyWorkspace',
  'createTicket',
  'getTicket',
  'listTickets',
  'searchTickets',
  'updateTicket',
  'deleteTicket',
  'addRelation',
  'removeRelation',
  'listRelations',
  'addComment',
  'listComments',
  'listHistory',
  'listWorkspaceHistory',
  'listEpicChildren',
  'epicSubtreeIds',
  'listEpicDescendants',
  'epicProgress',
];

/**
 * Open (or create) a scope workspace and return a handle with the data-layer
 * API bound to it.
 *
 * @param {string} [scopeDir] Path to the `.scope/` directory. Defaults to the
 *   nearest one at or above `process.cwd()`, then to `<cwd>/.scope`.
 * @returns {object} A handle exposing `db`, `scopeDir`, `close()`, and every
 *   data-layer method (`createTicket`, `updateTicket`, `listTickets`, …) with
 *   the underlying `db` pre-bound, so you call `ws.createTicket({...})` instead
 *   of `createTicket(db, {...})`.
 */
export function openWorkspace(scopeDir) {
  const dir = scopeDir ?? findScopeDir() ?? defaultScopeDir();
  const db = openDb(dir);
  ensureScopeGitignore(dir);
  ensureEventLog(db, dir);
  // Rebuild the cache if the on-disk log is ahead (e.g. after a git pull).
  syncFromLog(db, dir);

  const handle = {
    db,
    scopeDir: dir,
    close() {
      db.close();
    },
  };
  for (const name of REPO_METHODS) {
    handle[name] = (...args) => repo[name](db, ...args);
  }
  return handle;
}
