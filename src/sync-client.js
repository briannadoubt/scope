/**
 * Sync client (SCP-136) — the CLI side of the offline-first loop. Pushes this
 * workspace's local event log to a remote hub and pulls the remote's events
 * back, reconciling via the existing replay. The cloud node is "just another
 * replica" (ADR 0002): push is idempotent (the hub dedupes by ULID) and pull is
 * a ULID high-water cursor, persisted per remote+workspace in the meta table.
 *
 * Extracted from the CLI command so it can be tested hermetically against a
 * real hub (inject `fetchImpl`).
 */
import { readAllEvents, appendEvent, eventsDir } from './event-store.js';
import { syncFromLog } from './replay.js';
import { getMeta, setMeta } from './db.js';

/**
 * @param {import('better-sqlite3').Database} db - open local workspace db
 * @param {string} scopeDir - the local .scope dir
 * @param {object} opts
 * @param {string} opts.remote - remote hub base URL (e.g. https://hub.scope.dev)
 * @param {string} opts.remoteWorkspace - the remote workspace id to sync with
 * @param {string} [opts.token] - bearer token for the remote
 * @param {Function} [opts.fetchImpl] - injectable fetch (defaults to global)
 * @returns {Promise<{pushed:number,duplicates:number,pulled:number,renumbered:Array,cursor:string}>}
 */
export async function syncWithRemote(db, scopeDir, { remote, remoteWorkspace, token = '', fetchImpl = fetch } = {}) {
  if (!remote) throw new Error('remote hub URL is required (--remote)');
  if (!remoteWorkspace) throw new Error('remote workspace id is required (--remote-workspace)');
  const dir = eventsDir(scopeDir);
  const auth = token ? { Authorization: `Bearer ${token}` } : {};
  const url = (path) =>
    `${remote.replace(/\/$/, '')}${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(remoteWorkspace)}`;

  // PUSH: send the whole local log. Idempotent — the hub returns known ULIDs as
  // duplicates and never double-applies, so re-sync is safe and self-healing.
  const local = readAllEvents(dir);
  const pushResp = await fetchImpl(url('/api/sync/push'), {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'X-Scope-Workspace': remoteWorkspace },
    body: JSON.stringify({ events: local }),
  });
  if (!pushResp.ok) throw new Error(`push failed: HTTP ${pushResp.status}`);
  const push = await pushResp.json();

  // PULL: everything the remote has after our stored high-water cursor.
  const cursorKey = `sync_cursor:${remote}:${remoteWorkspace}`;
  const since = getMeta(db, cursorKey) || '';
  const pullResp = await fetchImpl(url(`/api/sync/pull?since=${encodeURIComponent(since)}`), {
    headers: { ...auth, 'X-Scope-Workspace': remoteWorkspace },
  });
  if (!pullResp.ok) throw new Error(`pull failed: HTTP ${pullResp.status}`);
  const pull = await pullResp.json();

  // Union the remote events into the local log (ULID filenames => idempotent),
  // then rebuild the cache from the merged log.
  const events = pull.events || [];
  for (const e of events) appendEvent(dir, e);
  if (events.length) syncFromLog(db, scopeDir);
  if (pull.cursor) setMeta(db, cursorKey, pull.cursor);

  return {
    pushed: (push.accepted || []).length,
    duplicates: (push.duplicates || []).length,
    pulled: events.length,
    renumbered: push.renumbered || [],
    cursor: pull.cursor || since,
  };
}
