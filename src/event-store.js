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
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, basename, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  UnsupportedEventVersionError,
  validateEvent,
  compareEvents,
  makeEvent,
} from './event-schema.js';
import { ulid } from './ulid.js';
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
  if (existsSync(finalPath)) {
    const existing = JSON.parse(readFileSync(finalPath, 'utf8'));
    validateEvent(existing);
    if (!isDeepStrictEqual(existing, event)) {
      throw new Error(`event id collision for ${event.id}: existing immutable event differs`);
    }
    return existing;
  }
  const fd = openSync(tmpPath, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(event, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
  // Persist the directory entry as well as the file contents. Some filesystems
  // reject fsync on directories; the file is still atomically visible there.
  try {
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch {}
  return event;
}

/**
 * Durably publish several events as one committed unit. Each member lands
 * first with transaction metadata; the commit marker lands last. Readers
 * ignore transaction members until that marker and every declared member are
 * present, so a crash or partial sync can never expose half a batch.
 */
export function appendTransaction(dir, events, { actor = null, model = null } = {}) {
  if (!Array.isArray(events) || events.length < 2)
    throw new Error('appendTransaction requires at least two events');
  const transactionId = ulid();
  const members = events.map((event, index) => {
    const member = { ...event, transactionId, transactionIndex: index };
    validateEvent(member);
    return member;
  });
  for (const [index, member] of members.entries()) {
    appendEvent(dir, member);
    eventStoreFailpoint(`after-member:${index + 1}`);
  }
  const commit = makeEvent(
    'transaction.commit',
    { transactionId, eventIds: members.map((event) => event.id) },
    { actor: actor || members[0].actor, model: model || members[0].model }
  );
  eventStoreFailpoint('before-commit');
  appendEvent(dir, commit);
  eventStoreFailpoint('after-commit');
  return { transactionId, events: members, commit };
}

function eventStoreFailpoint(point) {
  if (process.env.SCOPE_EVENT_FAILPOINT === point) {
    throw new Error(`injected event-store failure at ${point}`);
  }
}

/** Keep legacy standalone events and only fully committed transaction groups. */
export function committedEvents(events) {
  const commits = new Map();
  const members = new Map();
  for (const event of events) {
    if (event.kind === 'transaction.commit') {
      commits.set(event.payload.transactionId, event);
    } else if (event.transactionId) {
      if (!members.has(event.transactionId)) members.set(event.transactionId, new Map());
      members.get(event.transactionId).set(event.id, event);
    }
  }
  const acceptedTransactions = new Set();
  for (const [transactionId, commit] of commits) {
    const group = members.get(transactionId);
    if (!group || group.size !== commit.payload.eventIds.length) continue;
    const ordered = commit.payload.eventIds.map((id) => group.get(id));
    if (ordered.some((event) => !event)) continue;
    if (ordered.some((event, index) => event.transactionIndex !== index)) continue;
    acceptedTransactions.add(transactionId);
  }
  return events.filter((event) => {
    if (event.kind === 'transaction.commit') return acceptedTransactions.has(event.payload.transactionId);
    if (!event.transactionId) return true;
    return acceptedTransactions.has(event.transactionId);
  });
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
      // An event from a newer writer is valid data that this reader cannot
      // interpret, not corruption. Never let tolerant mode silently omit it:
      // doing so could project and then mutate an incomplete workspace.
      if (err instanceof UnsupportedEventVersionError) throw err;
      if (!tolerant) throw new Error(`Corrupt event file ${name}: ${err.message}`);
    }
  }
  return committedEvents(events).sort(compareEvents);
}

/** Machine-readable integrity report used by `scope doctor`. */
export function inspectEventStore(dir) {
  const report = {
    directory: dir,
    files: 0,
    validFiles: 0,
    effectiveEvents: 0,
    committedTransactions: 0,
    incompleteTransactions: [],
    orphanTransactionEvents: [],
    tempFiles: [],
    corruptFiles: [],
    incompatibleFiles: [],
    ok: true,
  };
  if (!existsSync(dir)) return report;
  const events = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name.startsWith('.') && name.endsWith('.tmp')) {
      report.tempFiles.push(name);
      continue;
    }
    if (!name.endsWith('.json') || !statSync(full).isFile()) continue;
    report.files += 1;
    try {
      const event = JSON.parse(readFileSync(full, 'utf8'));
      validateEvent(event);
      events.push(event);
      report.validFiles += 1;
    } catch (error) {
      const issue = { file: name, error: error.message };
      if (error instanceof UnsupportedEventVersionError) {
        report.incompatibleFiles.push({
          ...issue,
          version: error.version,
          supportedVersions: error.supportedVersions,
        });
      } else {
        report.corruptFiles.push(issue);
      }
    }
  }
  const effective = committedEvents(events);
  report.effectiveEvents = effective.length;
  const effectiveIds = new Set(effective.map((event) => event.id));
  const commits = events.filter((event) => event.kind === 'transaction.commit');
  report.committedTransactions = commits.filter((event) => effectiveIds.has(event.id)).length;
  report.incompleteTransactions = commits
    .filter((event) => !effectiveIds.has(event.id))
    .map((event) => ({ transactionId: event.payload.transactionId, expected: event.payload.eventIds.length }));
  report.orphanTransactionEvents = events
    .filter((event) => event.transactionId && !effectiveIds.has(event.id))
    .map((event) => event.id);
  report.ok = report.corruptFiles.length === 0
    && report.incompatibleFiles.length === 0
    && report.incompleteTransactions.length === 0
    && report.orphanTransactionEvents.length === 0;
  return report;
}
