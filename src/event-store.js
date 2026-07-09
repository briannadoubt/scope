/**
 * Event store — the append-only, one-file-per-event log on disk
 * (docs/event-log-format.md, SCP-108).
 *
 * Each event lives at `<resolved-events-dir>/<ulid>.json`. The resolved dir is
 * either machine-local storage (default) or `.scope/events` in git-events mode.
 * Writes are atomic (tmp + rename) so a concurrent reader or sync daemon never
 * sees a half-written event. Because filenames are globally-unique ULIDs, two
 * replicas appending concurrently never touch the same path — a merge is pure
 * union of files, with nothing to conflict on.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, basename, resolve, sep } from 'node:path';

import { validateEvent, compareEvents } from './event-schema.js';
import { workspaceEventsDir } from './workspace-storage.js';

export const EVENTS_DIR_NAME = 'events';

/** Reject an event id that can't be safely used as a filename (SCP-196). */
function fail_path(id) {
  throw new Error(`unsafe event id ${JSON.stringify(id)} (must be a bare ULID filename)`);
}

/** Absolute path to the authoritative events dir for a given .scope directory. */
export function eventsDir(scopeDir) {
  return workspaceEventsDir(scopeDir);
}

/**
 * Absolute path to the events dir for an open better-sqlite3 handle. The db and
 * event log live side-by-side in the resolved workspace data directory.
 */
export function eventsDirForDb(db) {
  return join(dirname(db.name), EVENTS_DIR_NAME);
}

/**
 * Append one validated event to the log. Atomic: writes to a temp file then
 * renames into place. Throws (via validateEvent) before writing anything if the
 * event is malformed, so a bad event never reaches disk.
 *
 * @param {string} dir - the events directory (from eventsDir / eventsDirForDb)
 * @param {object} event
 * @returns {object} the same event
 */
export function appendEvent(dir, event) {
  validateEvent(event);
  // Defense-in-depth (SCP-196): validateEvent already constrains id to a ULID,
  // but the id becomes a filename here, so refuse anything that isn't a bare
  // path segment and assert the resolved path stays inside `dir` — a belt to
  // the ULID-validation suspenders so a future validator gap can't traverse.
  if (basename(event.id) !== event.id) fail_path(event.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${event.id}.json`);
  const tmpPath = join(dir, `.${event.id}.json.tmp`);
  const root = resolve(dir) + sep;
  if (!resolve(finalPath).startsWith(root) || !resolve(tmpPath).startsWith(root)) fail_path(event.id);
  writeFileSync(tmpPath, JSON.stringify(event, null, 2));
  renameSync(tmpPath, finalPath);
  return event;
}

/**
 * Read every event in the log, validated and sorted into canonical order
 * (compareEvents). Missing dir → []. Skips temp files and non-JSON entries.
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {boolean} [opts.tolerant=false] - skip unreadable/invalid files
 *        instead of throwing (useful for diagnostics; replay should be strict).
 */
/**
 * Is the log at `dir` authoritative — i.e. has it been fully initialized as the
 * source of truth? Signalled by the presence of a `workspace.init` event, which
 * a complete backfill (SCP-113) always writes first. This signal lives in the
 * log itself, so it survives deletion of the scope.db cache and travels with the
 * events via git/sync. A merely *partial* log (e.g. stray set_field events
 * appended before a backfill ran) is NOT authoritative — which is what stops
 * syncFromLog from rebuilding the db out of incomplete data (SCP-111).
 */
export function logHasInit(dir) {
  if (!existsSync(dir)) return false;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      if (JSON.parse(readFileSync(join(dir, name), 'utf8'))?.kind === 'workspace.init') return true;
    } catch {
      /* ignore unreadable file */
    }
  }
  return false;
}

export function readAllEvents(dir, { tolerant = false } = {}) {
  if (!existsSync(dir)) return [];
  const events = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const full = join(dir, name);
    try {
      const evt = JSON.parse(readFileSync(full, 'utf8'));
      validateEvent(evt);
      events.push(evt);
    } catch (err) {
      if (!tolerant) throw new Error(`Corrupt event file ${name}: ${err.message}`);
    }
  }
  return events.sort(compareEvents);
}
