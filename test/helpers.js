import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../src/db.js';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';

/**
 * Create an isolated .scope directory + open a fresh DB. Returns a cleanup()
 * that closes the DB and removes the tmpdir.
 */
export function createTempScope() {
  const scopeDir = mkdtempSync(join(tmpdir(), 'scope-test-'));
  const db = openDb(scopeDir);
  return {
    scopeDir,
    db,
    cleanup() {
      try { db.close(); } catch {}
      try { rmSync(scopeDir, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * Spin up the real express server bound to a random free port, attached to a
 * fresh in-memory WorkspaceManager containing a single temp workspace. The
 * registry is NOT persisted (persist: false) so tests stay hermetic.
 *
 * Returns { server, baseUrl, workspaceId, scope, close }.
 */
export async function startTestServer() {
  const scope = createTempScope();
  const mgr = new WorkspaceManager();
  const ws = mgr.attach(scope.scopeDir, { persist: false, broadcast: false });
  // Re-use the open db handle from createTempScope so callers can seed/inspect
  // directly without going through the server.
  try { ws.db.close(); } catch {}
  ws.db = scope.db;

  const server = await startServer({
    workspaces: mgr,
    port: 0,
    silent: true,
    discoverable: false,
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    baseUrl,
    workspaceId: ws.id,
    scope,
    async close() {
      await new Promise((r) => server.close(() => r()));
      scope.cleanup();
    },
  };
}

/** Convenience fetch that throws on non-2xx. */
export async function apiFetch(baseUrl, path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const res = await fetch(baseUrl + path, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  return { status: res.status, data };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return s; }
}
