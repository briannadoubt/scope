import { EventEmitter } from 'node:events';

/**
 * Process-wide change bus. Subscribers (the SSE endpoint, mainly) listen here.
 * The fs.watch on the .scope dir feeds cross-process writes into the same bus,
 * so a write from any process the user runs (CLI, stdio MCP subprocess, the
 * serve process itself) shows up in the UI.
 */
export const bus = new EventEmitter();
bus.setMaxListeners(1000);

/**
 * Emit a coarse "something changed" event.
 * `detail` is a small JSON envelope ({ type, id, scope, ... }) the UI can
 * inspect — but the UI's simplest strategy is just to refresh on any tick.
 */
export function emitChange(detail = {}) {
  bus.emit('change', { ...detail, at: Date.now() });
}
