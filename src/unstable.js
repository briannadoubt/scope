/**
 * scope-kanban/unstable — low-level, *unversioned* data-layer access.
 *
 * ⚠️ Everything here is exempt from semver. Names, signatures, and behavior may
 * change or disappear in any release, including patches. Import from the package
 * root (`scope-kanban`) for the supported, stable API; reach in here only when
 * you specifically need to own the `better-sqlite3` handle or call the raw
 * `(db, …)` functions.
 *
 * Responsibility you take on by using these: {@link openDb} opens the SQLite
 * cache *only* — it does NOT ensure the append-only event log exists or replay
 * a log that's ahead of the cache. The stable `openWorkspace()` wires both for
 * you (`ensureEventLog` + `syncFromLog`); if you open the db yourself you must
 * handle that, or you can read/write against a stale cache after a `git pull`.
 *
 *     import { openDb, createTicket } from 'scope-kanban/unstable';
 *     import { ensureEventLog, syncFromLog } from 'scope-kanban/unstable';
 *     const db = openDb('/path/to/.scope');
 *     ensureEventLog(db, '/path/to/.scope');
 *     syncFromLog(db, '/path/to/.scope');
 *     createTicket(db, { type: 'bug', title: 'CSRF on /signup' });
 */

// Raw data layer — every function takes a `db` handle as its first argument.
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

// Event-log wiring you must run yourself when you open the db directly.
export { ensureEventLog } from './backfill.js';
export { syncFromLog, rebuildScopeDb } from './replay.js';

// Column classification helpers and the remaining enum plumbing.
export {
  COLUMN_KINDS,
  normalizeColumns,
  parseColumns,
  statusIds,
  openColumns,
  terminalColumns,
  doneColumnIds,
} from './columns.js';
export { RELATION_INVERSE, TICKET_FIELDS } from './enums.js';
