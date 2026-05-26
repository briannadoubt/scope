import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  watch,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { openDb } from './db.js';
import { emitChange } from './events.js';

/* Hub-level registry of all attached workspaces. Survives hub restarts so the
   UI doesn't lose its world when the hub bounces. */
const HUB_DIR = join(homedir(), '.scope-hub');
const REGISTRY_FILE = join(HUB_DIR, 'workspaces.json');

function readDataVersion(db) {
  try { return db.prepare('PRAGMA data_version').get()?.data_version ?? 0; }
  catch { return 0; }
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Stable, short id derived from the absolute scope-dir path. Different repos
 * get different ids; the same repo always gets the same id across hub restarts.
 */
export function workspaceIdFor(scopeDir) {
  return createHash('sha256').update(resolve(scopeDir)).digest('hex').slice(0, 10);
}

/**
 * Default human-readable label = basename of the repo directory (the parent
 * of `.scope/`). "foo/bar/.scope" → "bar".
 */
export function defaultLabelFor(scopeDir) {
  return basenameSafe(dirname(resolve(scopeDir))) || 'workspace';
}

function basenameSafe(p) {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * Tracks attached workspaces. Each workspace is { id, scope_dir, label, db,
 * watcher }. Persists the (id, scope_dir, label) tuples to disk so the hub
 * can rehydrate on restart.
 */
export class WorkspaceManager {
  constructor() {
    /** @type {Map<string, {id:string, scope_dir:string, label:string, db:any, watcher:any}>} */
    this.workspaces = new Map();
  }

  /**
   * Read the persisted registry and re-attach any workspaces whose scope_dir
   * still exists on disk. Returns the list of attached workspaces.
   */
  load() {
    if (!existsSync(REGISTRY_FILE)) return [];
    let saved;
    try { saved = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')); }
    catch { return []; }
    if (!Array.isArray(saved)) return [];
    for (const w of saved) {
      if (typeof w?.scope_dir !== 'string') continue;
      if (!existsSync(w.scope_dir)) continue;
      try {
        this.attach(w.scope_dir, { label: w.label, persist: false, broadcast: false });
      } catch {
        /* swallow — one bad workspace shouldn't kill the hub */
      }
    }
    return this.list();
  }

  /**
   * Persist the current registry to disk.
   */
  save() {
    if (!existsSync(HUB_DIR)) mkdirSync(HUB_DIR, { recursive: true });
    const list = [...this.workspaces.values()].map((w) => ({
      id: w.id, scope_dir: w.scope_dir, label: w.label,
    }));
    writeFileSync(REGISTRY_FILE, JSON.stringify(list, null, 2));
  }

  /**
   * Attach a workspace. Idempotent — re-attaching a known scope_dir updates
   * the label (if provided) and returns the existing entry.
   */
  attach(scopeDir, { label, persist = true, broadcast = true } = {}) {
    const abs = resolve(scopeDir);
    const id = workspaceIdFor(abs);
    const existing = this.workspaces.get(id);
    if (existing) {
      if (label && label !== existing.label) {
        existing.label = label;
        if (persist) this.save();
      }
      return existing;
    }

    const db = openDb(abs);
    let lastDataVersion = readDataVersion(db);

    const onChange = debounce(() => {
      const v = readDataVersion(db);
      if (v !== lastDataVersion) {
        lastDataVersion = v;
        emitChange({ type: 'external', source: 'fs-watch', workspace: id });
      }
    }, 80);

    let watcher = null;
    try {
      watcher = watch(abs, { persistent: false }, (_event, filename) => {
        if (!filename || !String(filename).startsWith('scope.db')) return;
        onChange();
      });
    } catch {
      /* fs.watch not available — cross-process updates degrade to "next tool call refreshes" */
    }

    // Keep lastDataVersion in sync with our own in-process writes so the
    // watcher doesn't re-emit for them.
    const tracker = (detail) => {
      if (detail?.workspace === id) lastDataVersion = readDataVersion(db);
    };
    // Lazy import to avoid circular dependency at module load.
    import('./events.js').then(({ bus }) => bus.on('change', tracker));

    const ws = {
      id,
      scope_dir: abs,
      label: label || defaultLabelFor(abs),
      db,
      watcher,
      _tracker: tracker,
    };
    this.workspaces.set(id, ws);
    if (persist) this.save();
    if (broadcast) emitChange({ type: 'workspace.attached', workspace: id });
    return ws;
  }

  detach(id, { persist = true, broadcast = true } = {}) {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    try { ws.watcher?.close(); } catch {}
    try { ws.db?.close(); } catch {}
    import('./events.js').then(({ bus }) => bus.off('change', ws._tracker));
    this.workspaces.delete(id);
    if (persist) this.save();
    if (broadcast) emitChange({ type: 'workspace.detached', workspace: id });
    return true;
  }

  /** Lookup by id, or `null`. */
  get(id) {
    return this.workspaces.get(id) || null;
  }

  /** All workspaces in attach order. */
  list() {
    return [...this.workspaces.values()].map((w) => ({
      id: w.id, scope_dir: w.scope_dir, label: w.label,
    }));
  }

  /**
   * Resolve a workspace from a request:
   *  - explicit ?workspace=<id> query param
   *  - X-Scope-Workspace header
   *  - fall back to the first attached workspace (handy for single-workspace
   *    setups that don't bother passing the id)
   * Returns the workspace object or throws Error("...") on miss.
   */
  resolveFromRequest(req) {
    const id = req.query?.workspace || req.headers?.['x-scope-workspace'];
    if (id) {
      const w = this.get(id);
      if (!w) throw new Error(`Unknown workspace: ${id}`);
      return w;
    }
    const first = [...this.workspaces.values()][0];
    if (!first) throw new Error('No workspaces attached to this hub');
    return first;
  }
}

export const HUB_REGISTRY_PATH = REGISTRY_FILE;
