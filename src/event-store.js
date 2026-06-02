/**
 * Event store — the append-only, one-file-per-event log on disk
 * (docs/event-log-format.md, SCP-108).
 *
 * Each event lives at `.scope/events/<ulid>.json`. Writes are atomic
 * (tmp + rename) so a concurrent reader or sync daemon never sees a
 * half-written event. Because filenames are globally-unique ULIDs, two
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
import { dirname, join } from 'node:path';

import { validateEvent, compareEvents } from './event-schema.js';

export const EVENTS_DIR_NAME = 'events';

/** Absolute path to the events dir for a given .scope directory. */
export function eventsDir(scopeDir) {
  return join(scopeDir, EVENTS_DIR_NAME);
}

/**
 * Absolute path to the events dir for an open better-sqlite3 handle. The db
 * lives at `<scopeDir>/scope.db`, so its parent dir is the .scope dir.
 */
export function eventsDirForDb(db) {
  return eventsDir(dirname(db.name));
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, `${event.id}.json`);
  const tmpPath = join(dir, `.${event.id}.json.tmp`);
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
