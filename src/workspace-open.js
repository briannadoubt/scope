import { openDb, ensureScopeGitignore } from './db.js';
import { ensureEventLog } from './backfill.js';
import { syncFromLog } from './replay.js';

/**
 * Canonical "open a workspace for use" sequence — the single source of truth
 * shared by the CLI (`openOrDie`), the hub's workspace registry
 * (`WorkspaceManager.attach`), and the library facade (`openWorkspace`). Keeping
 * the orchestration here means the three front-ends can never drift on how a
 * workspace is brought up.
 *
 * The steps, in order:
 *   1. openDb              — open (and migrate) the SQLite cache.
 *   2. ensureScopeGitignore — write the `.scope/.gitignore` for the storage mode
 *                             (idempotent; existing workspaces get it on first use).
 *   3. ensureEventLog       — make the append-only log authoritative (backfill
 *                             from the db once if the log is empty/partial).
 *   4. syncFromLog          — rebuild the cache if the on-disk log is ahead
 *                             (e.g. after a git pull or a sibling process wrote).
 *
 * Callers that need to locate the directory first (find the nearest `.scope/`,
 * fail if missing, honor `SCOPE_DIR`, …) do that themselves and pass an
 * absolute path in — this function assumes the target directory is decided.
 *
 * @param {string} scopeDir  Absolute path to the `.scope/` directory.
 * @returns {{ db: object, scopeDir: string }} The open db handle and the dir.
 */
export function openWorkspaceDb(scopeDir) {
  const db = openDb(scopeDir);
  ensureScopeGitignore(scopeDir);
  ensureEventLog(db, scopeDir);
  syncFromLog(db, scopeDir);
  return { db, scopeDir };
}
