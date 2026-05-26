import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Hub auto-discovery and lifecycle.
 *
 * The contract: any scope CLI command that wants a hub calls `ensureHub()`.
 * If one is already running anywhere in the port range, we attach our
 * workspace to it and return its URL. Otherwise we bind the first available
 * port and become the hub ourselves.
 *
 * This is what makes `scope ui`, `scope serve`, and `scope mcp` safe to run
 * concurrently from multiple Claude sessions / previews / repos — they all
 * converge on a single shared hub.
 */

const HUB_DIR = join(homedir(), '.scope-hub');
const HUB_FILE = join(HUB_DIR, 'hub.json');

export const DEFAULT_HUB_PORT = 4321;
export const HUB_PORT_RANGE = 10;

/**
 * Probe a port to see if a scope hub is answering on it. Returns the parsed
 * `/api/meta` body (which includes the hub descriptor) or null.
 */
export async function probeHub(port, { timeoutMs = 400 } = {}) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(`http://localhost:${port}/api/meta`, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const body = await r.json();
    if (!body || typeof body !== 'object' || !body.hub) return null;
    return body;
  } catch {
    return null;
  }
}

function readDiscovery() {
  if (!existsSync(HUB_FILE)) return null;
  try { return JSON.parse(readFileSync(HUB_FILE, 'utf8')); } catch { return null; }
}

function writeDiscovery(d) {
  if (!existsSync(HUB_DIR)) mkdirSync(HUB_DIR, { recursive: true });
  writeFileSync(HUB_FILE, JSON.stringify(d, null, 2));
}

function clearDiscovery(ownerPid) {
  const cur = readDiscovery();
  if (!cur) return;
  // Only clear if this process is the recorded owner — otherwise we'd be
  // wiping someone else's record.
  if (ownerPid !== undefined && cur.pid !== ownerPid) return;
  try { unlinkSync(HUB_FILE); } catch {}
}

/**
 * Locate a running scope hub. Tries the discovery file first, then scans the
 * port range. Returns `{ port, url, meta }` or null.
 */
export async function findRunningHub(preferredPort = DEFAULT_HUB_PORT) {
  const tried = new Set();
  const disc = readDiscovery();
  if (disc?.port) {
    tried.add(disc.port);
    const meta = await probeHub(disc.port);
    if (meta) return { port: disc.port, url: `http://localhost:${disc.port}`, meta };
  }
  for (let p = preferredPort; p < preferredPort + HUB_PORT_RANGE; p++) {
    if (tried.has(p)) continue;
    const meta = await probeHub(p);
    if (meta) {
      // Refresh the discovery pointer so the next caller finds it instantly.
      writeDiscovery({ ...(disc || {}), port: p, updated_at: new Date().toISOString() });
      return { port: p, url: `http://localhost:${p}`, meta };
    }
  }
  // Stale discovery file — clear it so we don't keep probing a dead port.
  if (disc && !disc.pid) clearDiscovery();
  return null;
}

async function registerWorkspace(url, scopeDir, label) {
  try {
    await fetch(`${url}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope_dir: scopeDir, label }),
    });
  } catch {
    /* hub vanished between probe and POST — caller will deal */
  }
}

/**
 * Ensure a scope hub is running, and attach `scopeDir` to it.
 *
 * Returns:
 *   { url, port, weAreHub, server?, workspaces? }
 *
 * - `weAreHub: true`  → we started the hub in this process; `server` is the
 *   http.Server (caller is responsible for keeping the process alive / closing
 *   it on shutdown). `workspaces` is the WorkspaceManager.
 * - `weAreHub: false` → an existing hub is serving; we registered our
 *   workspace with it. Caller can exit, or stay running for other reasons
 *   (e.g. stdio MCP).
 */
export async function ensureHub({
  scopeDir,
  label,
  preferredPort = DEFAULT_HUB_PORT,
  serveUi = true,
  mcpFactory = null,
  openBrowser = false,
} = {}) {
  // 1. Reuse an existing hub if one is already up.
  const existing = await findRunningHub(preferredPort);
  if (existing) {
    if (scopeDir) await registerWorkspace(existing.url, scopeDir, label);
    if (openBrowser) {
      try { (await import('open')).default(existing.url); } catch {}
    }
    return {
      url: existing.url,
      port: existing.port,
      weAreHub: false,
      meta: existing.meta,
    };
  }

  // 2. Start one ourselves. Walk the port range to dodge non-scope squatters.
  const { startServer } = await import('./server.js');
  const { WorkspaceManager } = await import('./workspaces.js');
  const mgr = new WorkspaceManager();
  mgr.load();
  if (scopeDir) mgr.attach(scopeDir, { label });

  let lastErr;
  for (let p = preferredPort; p < preferredPort + HUB_PORT_RANGE; p++) {
    try {
      const server = await startServer({
        workspaces: mgr,
        port: p,
        open: false, // we open ourselves after writing discovery
        mcpFactory,
        serveUi,
        quiet: true,
      });
      writeDiscovery({
        port: p,
        pid: process.pid,
        started_at: new Date().toISOString(),
      });
      installShutdownHandlers(p);
      if (openBrowser) {
        try { (await import('open')).default(`http://localhost:${p}`); } catch {}
      }
      return {
        url: `http://localhost:${p}`,
        port: p,
        weAreHub: true,
        server,
        workspaces: mgr,
      };
    } catch (e) {
      lastErr = e;
      if (e?.code !== 'EADDRINUSE') throw e;
      // Lost a startup race? Maybe a sibling scope process beat us to this
      // port. Probe before walking past it.
      const meta = await probeHub(p);
      if (meta) {
        const url = `http://localhost:${p}`;
        if (scopeDir) await registerWorkspace(url, scopeDir, label);
        writeDiscovery({ port: p, updated_at: new Date().toISOString() });
        if (openBrowser) {
          try { (await import('open')).default(url); } catch {}
        }
        return { url, port: p, weAreHub: false, meta };
      }
      // Some other process owns this port — try the next one.
    }
  }
  throw lastErr ?? new Error(
    `Could not bind any port in ${preferredPort}..${preferredPort + HUB_PORT_RANGE - 1}`
  );
}

let shutdownInstalled = false;
function installShutdownHandlers(port) {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  const pid = process.pid;
  const cleanup = () => clearDiscovery(pid);
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
}
