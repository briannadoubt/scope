import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Process-wide change bus. Subscribers (the SSE endpoint, mainly) listen here.
 * The fs.watch on each attached workspace feeds cross-process writes into the
 * same bus, so a write from any process (CLI, stdio MCP subprocess, hub
 * itself) shows up in the UI.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(1000);

/**
 * Workspace context — set per-request so emitChange() can tag events with the
 * workspace they belong to without every repo function needing to thread an
 * extra argument. Servers wrap their request handlers in `wsContext.run(id, ...)`.
 */
export const wsContext = new AsyncLocalStorage();

/**
 * Emit a coarse "something changed" event.
 * `detail` is a small JSON envelope ({ type, id, workspace, ... }) the UI can
 * inspect — the UI's simplest strategy is to refresh on any tick for the
 * currently-selected workspace.
 */
export function emitChange(detail = {}) {
  const final = { ...detail, at: Date.now() };
  if (!final.workspace) {
    const ctx = wsContext.getStore();
    if (ctx) final.workspace = ctx;
  }
  bus.emit('change', final);
}
