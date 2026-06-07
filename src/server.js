import express from 'express';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import open from 'open';
import chalk from 'chalk';
import Bonjour from 'bonjour-service';
import { loadOrCreateCa, fingerprintHex } from './ca.js';
import { ensureLeafCert, collectSans } from './tls.js';
import { signCsr } from './ca.js';
import { addDevice } from './devices.js';
import { createPairingContext } from './pair.js';
import { reloadCrl, installCrlReloadSignal } from './revocation.js';
import { bus, wsContext, emitChange } from './events.js';
import { readAllEvents, appendEvent, eventsDirForDb } from './event-store.js';
import { replayInto } from './replay.js';
import { setMeta } from './db.js';
import { validateEvent } from './event-schema.js';
import {
  getWorkspace,
  setWorkspace,
  listWorkspaces,
  updateWorkspace,
  listWorkspaceHistory,
  createTicket,
  getTicket,
  listTickets,
  searchTickets,
  updateTicket,
  deleteTicket,
  addRelation,
  removeRelation,
  listRelations,
  addComment,
  listComments,
  listHistory,
  listEpicChildren,
  epicProgress,
  SCHEMA_STATUSES,
  SCHEMA_PRIORITIES,
  SCHEMA_TICKET_TYPES,
  SCHEMA_RELATION_TYPES,
} from './repo.js';
import { WorkspaceManager } from './workspaces.js';
import { loadOrCreateToken, authMiddleware, lanHosts } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

/**
 * Start the local hub server.
 *
 * The server is workspace-aware: it manages a registry of attached
 * workspaces (each its own .scope/scope.db), and every REST endpoint resolves
 * a workspace from `?workspace=<id>` (or `X-Scope-Workspace` header). If no
 * workspace is specified, the first attached one is used.
 *
 * @param {object} opts
 * @param {WorkspaceManager} [opts.workspaces] - existing workspace manager. If
 *                                              not provided, a new one is
 *                                              created and `opts.scopeDir` is
 *                                              attached as the first workspace.
 * @param {string}   [opts.scopeDir]    - convenience: attach this scope dir
 *                                        as the initial workspace.
 * @param {number}   opts.port
 * @param {boolean}  [opts.open]        - open browser after start
 * @param {boolean}  [opts.quiet=false] - log banner to stderr
 */
export async function startServer({
  workspaces,
  scopeDir,
  port,
  open: openBrowser,
  quiet = false,
  silent = false,
  discoverable = true,
  /**
   * TLS configuration.
   *   - `undefined` (default): generate / load the local CA + leaf and serve
   *     HTTPS. Production behavior.
   *   - `false`: serve plain HTTP. Used by the test suite and by callers that
   *     want to layer their own TLS termination.
   *   - `{ ca, leaf }` object: use the supplied CA + leaf without touching
   *     disk. Useful for tests that exercise HTTPS specifically.
   */
  tls,
}) {
  const log = silent
    ? () => {}
    : quiet
      ? (...args) => process.stderr.write(args.join(' ') + '\n')
      : (...args) => process.stdout.write(args.join(' ') + '\n');

  const mgr = workspaces ?? new WorkspaceManager();
  // Always rehydrate persisted workspaces first so the UI sees them.
  if (!workspaces) mgr.load();
  // Then attach the scopeDir for this invocation (if given) so it's also in
  // the registry — idempotent for already-known dirs.
  if (scopeDir) mgr.attach(scopeDir);

  const token = loadOrCreateToken();
  // Prime the in-memory CRL from disk and install SIGUSR1 so revokes done by
  // out-of-process CLI calls (`scope devices revoke`) get picked up live.
  reloadCrl();
  installCrlReloadSignal();
  const app = express();

  // Pairing context lives for the lifetime of the server. The /api/pair/*
  // routes are mounted BEFORE authMiddleware: pair/begin is loopback-only
  // anyway (loopback bypasses auth), and pair/complete must be reachable by
  // an unauthenticated device (that's the whole point of pairing — it's how
  // a device becomes authenticated). pair/complete gates itself on the
  // single-use short code + a rate limit.
  const pairing = createPairingContext();

  app.use(express.json({ limit: '5mb' }));

  // POST /api/pair/begin — issue a fresh pairing code. Loopback only (so
  // only the local `scope pair` CLI can request one).
  app.post('/api/pair/begin', (req, res) => {
    const ip = req.socket?.remoteAddress || '';
    const isLoop = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLoop) return res.status(403).json({ error: 'loopback only' });
    const { code, expiresAt } = pairing.pending.issue();
    res.json({ code, expires_at: new Date(expiresAt).toISOString(), ttl_ms: expiresAt - Date.now() });
  });

  // POST /api/pair/complete — { code, csr_pem, device_name }. Rate-limited
  // per IP. On success: signs the CSR, records the device, fires 'consumed'
  // on the code's EE so the waiting CLI sees the success.
  app.post('/api/pair/complete', (req, res) => {
    const ip = req.socket?.remoteAddress || 'unknown';
    const rl = pairing.limiter.check(ip);
    if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      return res.status(429).json({ error: 'too many attempts', retry_after_ms: rl.retryAfterMs });
    }
    const { code, csr_pem, device_name } = req.body || {};
    if (typeof code !== 'string' || typeof csr_pem !== 'string' || typeof device_name !== 'string') {
      return res.status(400).json({ error: 'code, csr_pem, device_name required' });
    }
    if (!/^[a-zA-Z0-9_\-. ]{1,64}$/.test(device_name)) {
      return res.status(400).json({ error: 'invalid device_name' });
    }
    const ee = pairing.pending.consume(code);
    if (!ee) return res.status(401).json({ error: 'invalid or expired code' });

    // Sign the CSR with the CA. We override the CN with the device name so
    // it's authoritative — clients can't claim a different identity in their
    // CSR than the one the user typed at the `scope pair` prompt.
    let signed;
    try {
      signed = signCsr({ ca: tlsCtx?.ca ?? loadOrCreateCa(), csrPem: csr_pem, commonName: device_name });
    } catch (e) {
      return res.status(400).json({ error: `CSR rejected: ${e.message}` });
    }

    const device = addDevice({
      name: device_name,
      certPem: signed.certPem,
      serialHex: signed.serialHex,
      notAfter: signed.notAfter,
    });
    pairing.limiter.reset(ip); // success clears the counter

    const ca = tlsCtx?.ca ?? loadOrCreateCa();
    const payload = {
      cert_pem: signed.certPem,
      ca_pem: ca.certPem,
      device,
    };
    ee.emit('consumed', { ...payload, ip });
    res.status(201).json(payload);
  });

  app.use(authMiddleware({ token, allowedHosts: lanHosts() }));

  /* ---------- workspace helpers ---------- */

  /**
   * Resolve the workspace for a request; on miss, send a 404 and return null.
   * Caller should `if (!ws) return;`
   */
  function resolveWs(req, res) {
    try { return mgr.resolveFromRequest(req); }
    catch (e) { res.status(404).json({ error: e.message }); return null; }
  }

  /**
   * Wrap a handler so emits inside it get tagged with the workspace id.
   * Also resolves the workspace and passes it as the third argument.
   */
  function ws(handler) {
    return (req, res, next) => {
      const w = resolveWs(req, res);
      if (!w) return;
      wsContext.run(w.id, () => {
        try { handler(req, res, w, next); }
        catch (e) { res.status(400).json({ error: e.message }); }
      });
    };
  }

  /* ---------- meta ---------- */

  app.get('/api/meta', (_req, res) => {
    const security = tlsCtx
      ? { scheme: 'https', auth: ['bearer', 'mtls'], ca_fingerprint: fingerprintHex(tlsCtx.ca.certPem) }
      : { scheme: 'http', auth: ['bearer'] };
    res.json({
      version: PKG.version,
      statuses: SCHEMA_STATUSES,
      priorities: SCHEMA_PRIORITIES,
      ticket_types: SCHEMA_TICKET_TYPES,
      relation_types: SCHEMA_RELATION_TYPES,
      hub: { port, workspaces: enrichedWorkspaces() },
      security,
    });
  });

  /* ---------- workspaces ---------- */

  /**
   * Enrich the WorkspaceManager listing with each workspace's singleton row
   * (key/name/description/overview). Tolerates missing/uninitialized rows.
   */
  function enrichedWorkspaces() {
    return mgr.list().map((w) => {
      const ws = mgr.get(w.id);
      let row = null;
      try { row = ws ? getWorkspace(ws.db) : null; } catch { row = null; }
      return {
        id: w.id,
        scope_dir: w.scope_dir,
        label: w.label,
        key: row?.key ?? null,
        name: row?.name ?? null,
        description: row?.description ?? '',
        overview: row?.overview ?? '',
      };
    });
  }

  /**
   * Synthesize a v1-shaped project payload from a workspace + its singleton row.
   * id is the lowercased key so old clients have something kebab-ish.
   */
  function projectFromWorkspace(w) {
    const ws = mgr.get(w.id);
    if (!ws) return null;
    let row;
    try { row = getWorkspace(ws.db); } catch { return null; }
    return {
      id: row.key.toLowerCase(),
      key: row.key,
      name: row.name,
      description: row.description ?? '',
      overview: row.overview ?? '',
      created_at: row.created_at,
      updated_at: row.updated_at,
      workspace: w.id,
    };
  }

  /**
   * Attribution context for a mutating request (SCP-128). `by` is the human
   * principal, `model` the acting agent ("Opus 4.8"); history renders
   * "{model} on behalf of {by}". Prefer the X-Scope-By / X-Scope-Model headers
   * (set once per agent client); fall back to body `__by` / `__model`.
   */
  function actorCtx(req) {
    const b = req.body || {};
    return {
      by: req.get('x-scope-by') || b.__by || null,
      model: req.get('x-scope-model') || b.__model || null,
    };
  }

  /** Strip attribution sentinels from a body before it reaches a repo writer. */
  function cleanBody(body) {
    const out = { ...(body || {}) };
    delete out.__by;
    delete out.__model;
    return out;
  }

  app.get('/api/workspaces', (_req, res) => res.json(enrichedWorkspaces()));

  app.post('/api/workspaces', (req, res) => {
    try {
      const { scope_dir, label } = req.body || {};
      if (!scope_dir || typeof scope_dir !== 'string') {
        return res.status(400).json({ error: 'scope_dir is required' });
      }
      const w = mgr.attach(scope_dir, { label });
      res.status(201).json({ id: w.id, scope_dir: w.scope_dir, label: w.label });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch('/api/workspaces/:id', (req, res) => {
    const w = mgr.get(req.params.id);
    if (!w) return res.status(404).json({ error: 'unknown workspace' });
    try {
      wsContext.run(w.id, () => {
        const { by, model } = actorCtx(req);
        const updated = updateWorkspace(w.db, cleanBody(req.body), by, model);
        res.json({
          id: w.id,
          scope_dir: w.scope_dir,
          label: w.label,
          key: updated.key,
          name: updated.name,
          description: updated.description ?? '',
          overview: updated.overview ?? '',
        });
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/workspaces/:id', (req, res) => {
    const ok = mgr.detach(req.params.id);
    if (!ok) return res.status(404).json({ error: 'unknown workspace' });
    res.json({ detached: req.params.id });
  });

  /* ---------- projects (back-compat synthesized from workspace rows) ---------- */

  app.get('/api/projects', (req, res) => {
    const filterWs = req.query.workspace;
    const list = mgr.list()
      .filter((w) => !filterWs || w.id === filterWs)
      .map(projectFromWorkspace)
      .filter(Boolean);
    res.json(list);
  });

  app.get('/api/projects/:idOrKey', ws((req, res, w) => {
    const p = projectFromWorkspace({ id: w.id });
    if (!p) return res.status(404).json({ error: 'not found' });
    const idOrKey = req.params.idOrKey;
    if (
      idOrKey &&
      idOrKey.toLowerCase() !== p.id &&
      idOrKey.toUpperCase() !== p.key
    ) {
      return res.status(404).json({ error: 'not found' });
    }
    const tickets = listTickets(w.db);
    const epics = tickets
      .filter((t) => t.type === 'epic')
      .map((e) => ({ ...e, progress: epicProgress(w.db, e.id) }));
    res.json({ ...p, tickets, epics });
  }));

  app.patch('/api/projects/:idOrKey', ws((req, res, w) => {
    const { by, model } = actorCtx(req);
    const updated = updateWorkspace(w.db, cleanBody(req.body), by, model);
    res.json({
      id: updated.key.toLowerCase(),
      key: updated.key,
      name: updated.name,
      description: updated.description ?? '',
      overview: updated.overview ?? '',
      created_at: updated.created_at,
      updated_at: updated.updated_at,
      workspace: w.id,
    });
  }));

  /* ---------- tickets ---------- */

  app.get('/api/tickets', ws((req, res, w) => {
    const { type, status, parent, assignee } = req.query;
    const filter = { type, status, assignee };
    if (parent !== undefined) filter.parentId = parent === 'none' ? null : parent;
    res.json(listTickets(w.db, filter));
  }));

  // Full-text search. MUST be declared before `/api/tickets/:id` so the
  // literal "search" segment isn't captured as an :id.
  app.get('/api/tickets/search', ws((req, res, w) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(searchTickets(w.db, q, { limit: req.query.limit }));
  }));

  app.get('/api/tickets/:id', ws((req, res, w) => {
    const t = getTicket(w.db, req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({
      ...t,
      relations: listRelations(w.db, t.id),
      comments: listComments(w.db, t.id),
      history: listHistory(w.db, t.id),
      children: t.type === 'epic' ? listEpicChildren(w.db, t.id) : [],
      progress: t.type === 'epic' ? epicProgress(w.db, t.id) : null,
    });
  }));

  app.post('/api/tickets', ws((req, res, w) => {
    const { by, model } = actorCtx(req);
    const body = cleanBody(req.body);
    // Strip legacy v1 fields so they don't confuse createTicket().
    delete body.project;
    delete body.projectIdOrKey;
    delete body.workspace;
    const t = createTicket(w.db, { ...body, actor: by, model });
    res.status(201).json(t);
  }));

  app.patch('/api/tickets/:id', ws((req, res, w) => {
    const { by, model } = actorCtx(req);
    const body = cleanBody(req.body);
    const t = updateTicket(w.db, req.params.id, body, by, model);
    res.json(t);
  }));

  app.delete('/api/tickets/:id', ws((req, res, w) => {
    const { by, model } = actorCtx(req);
    const ok = deleteTicket(w.db, req.params.id, by, model);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: req.params.id });
  }));

  /* ---------- relations ---------- */

  app.get('/api/tickets/:id/relations', ws((req, res, w) => {
    res.json(listRelations(w.db, req.params.id));
  }));

  app.post('/api/tickets/:id/relations', ws((req, res, w) => {
    const { to, type } = req.body;
    const { by, model } = actorCtx(req);
    res.status(201).json(addRelation(w.db, req.params.id, to, type, by, model));
  }));

  app.delete('/api/tickets/:id/relations', ws((req, res, w) => {
    const { to, type } = req.body;
    const { by, model } = actorCtx(req);
    removeRelation(w.db, req.params.id, to, type, by, model);
    res.json({ ok: true });
  }));

  /* ---------- comments ---------- */

  app.get('/api/tickets/:id/comments', ws((req, res, w) => {
    res.json(listComments(w.db, req.params.id));
  }));

  app.post('/api/tickets/:id/comments', ws((req, res, w) => {
    const { model } = actorCtx(req);
    const c = addComment(w.db, req.params.id, req.body.body, req.body.author, model);
    res.status(201).json(c);
  }));

  /* ---------- history ---------- */

  app.get('/api/history', ws((req, res, w) => {
    const { limit, before, beforeId } = req.query;
    const rows = listWorkspaceHistory(w.db, { limit, before, beforeId });
    res.json({ entries: rows, limit: rows.length, before: before ?? null });
  }));

  /* ---------- sync (SCP-134) ----------
   * Offline-first sync transport over the event log. The cloud node is "just
   * another replica": clients keep their local logs and reconcile here. Pull
   * streams events after a ULID high-water cursor; push unions uploaded events
   * onto the log, re-replays (the SAME deterministic pipeline a local replica
   * runs, so server state == local file-union replay), and reports renumber
   * notices. Idempotent: re-pushing a known ULID is a no-op.
   *
   * Single-tenant per-workspace for now; multi-tenant isolation + on-upload
   * actor authz arrive with SCP-122/SCP-124. */
  const SYNC_MAX = 1000;

  app.get('/api/sync/pull', ws((req, res, w) => {
    const since = typeof req.query.since === 'string' ? req.query.since : null;
    const limit = Math.min(Number(req.query.limit) || SYNC_MAX, SYNC_MAX);
    const all = readAllEvents(eventsDirForDb(w.db));
    // Paginate by the ULID high-water mark (id-sorted), independent of canonical
    // (ts,id) order — the client replays canonically regardless, so send order
    // doesn't affect correctness, and id-sorting keeps the cursor monotonic.
    const ahead = all
      .filter((e) => !since || e.id > since)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const page = ahead.slice(0, limit);
    res.json({
      events: page,
      cursor: page.length ? page[page.length - 1].id : since,
      count: all.length, // count guard: lets a client detect late backfill below its cursor
      more: ahead.length > limit,
    });
  }));

  app.post('/api/sync/push', ws((req, res, w) => {
    const incoming = Array.isArray(req.body?.events) ? req.body.events : null;
    if (!incoming) return res.status(400).json({ error: 'body.events must be an array' });
    // Validate the whole batch up front so a bad event lands nothing (atomic).
    try {
      for (const e of incoming) validateEvent(e);
    } catch (e) {
      return res.status(400).json({ error: `invalid event: ${e.message}` });
    }
    const dir = eventsDirForDb(w.db);
    const existing = new Set(readAllEvents(dir).map((e) => e.id));
    const accepted = [];
    const duplicates = [];
    for (const e of incoming) {
      if (existing.has(e.id)) { duplicates.push(e.id); continue; }
      appendEvent(dir, e); // atomic tmp+rename; ULID filename => union semantics
      existing.add(e.id);
      accepted.push(e.id);
    }
    const all = readAllEvents(dir);
    let renumbered = [];
    if (accepted.length) {
      // Full re-replay (SCP-143 will make this incremental). Keep the cache's
      // applied-count in step so a later open doesn't think it's stale.
      ({ renumbered } = replayInto(w.db, all));
      setMeta(w.db, 'applied_event_count', all.length);
      // Coarse notify so connected viewers refresh (granular fan-out = SCP-146).
      emitChange({ type: 'sync.applied', workspace: w.id, applied: accepted.length });
    }
    // Cursor = the max ULID now in the log (the client's new high-water mark).
    const cursor = all.length ? all.reduce((m, e) => (e.id > m ? e.id : m), all[0].id) : null;
    res.json({ accepted, duplicates, renumbered, cursor, count: all.length });
  }));

  /* ---------- board ---------- */

  app.get('/api/board', ws((req, res, w) => {
    const { epic } = req.query;
    const tickets = listTickets(w.db, { parentId: epic });
    const buckets = Object.fromEntries(SCHEMA_STATUSES.map((s) => [s, []]));
    for (const t of tickets) if (buckets[t.status]) buckets[t.status].push(t);
    res.json({ columns: SCHEMA_STATUSES, buckets });
  }));

  /* ---------- SSE ---------- */

  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n');
    res.write(
      `event: hello\ndata: ${JSON.stringify({ workspaces: enrichedWorkspaces() })}\n\n`
    );

    // Optional filter — UI can pass ?workspace=<id> to only receive that
    // workspace's events. Workspace-lifecycle events (.attached/.detached)
    // are always broadcast so the picker can refresh.
    const filterWs = req.query?.workspace;
    const send = (detail) => {
      if (
        filterWs &&
        detail?.workspace &&
        detail.workspace !== filterWs &&
        detail.type !== 'workspace.attached' &&
        detail.type !== 'workspace.detached'
      ) {
        return;
      }
      res.write(`event: change\ndata: ${JSON.stringify(detail)}\n\n`);
    };
    bus.on('change', send);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 20000);

    req.on('close', () => {
      bus.off('change', send);
      clearInterval(keepalive);
    });
  });

  /* ---------- static UI ---------- */

  app.use(express.static(join(__dirname, 'web')));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.sendFile(join(__dirname, 'web', 'index.html'));
  });

  // Resolve TLS configuration. `tls === false` keeps the legacy HTTP path
  // for tests; anything else (including undefined) means HTTPS on LAN.
  let tlsCtx = null;
  if (tls !== false) {
    if (tls && tls.ca && tls.leaf) {
      tlsCtx = tls;
    } else {
      const ca = loadOrCreateCa();
      const leaf = ensureLeafCert({ ca, sans: collectSans() });
      tlsCtx = { ca, leaf };
    }
  }

  // Always serve plain HTTP on loopback — no cert warnings for local browsers.
  // Auth middleware still enforces the bearer token for non-loopback requests,
  // but loopback bypasses auth entirely so `http://localhost` just works.
  const loopbackServer = http.createServer(app);
  await new Promise((res, rej) => {
    loopbackServer.once('error', rej);
    loopbackServer.listen(port, '127.0.0.1', res);
  });
  const actualPort = loopbackServer.address().port;

  // If TLS is configured and a LAN IP is available, also bind an HTTPS server
  // to that interface at the same port. Both servers share the same Express app.
  // Binding to the specific LAN IP (not 0.0.0.0) lets us coexist with the HTTP
  // loopback server on the same port.
  const lanIp = pickLanIp();
  let lanServer = null;
  if (tlsCtx && lanIp) {
    lanServer = https.createServer({
      key: tlsCtx.leaf.keyPem,
      cert: tlsCtx.leaf.certPem,
      ca: tlsCtx.ca.certPem,
      // Request — but do not require — client certs. Browsers without a
      // cert can still connect (they'll auth with the bearer cookie);
      // native clients that present a CA-signed cert get mTLS auth via
      // authMiddleware. `rejectUnauthorized:false` lets unauth peers
      // through; the middleware re-checks `socket.authorized` so a
      // forged/untrusted cert can never be accepted as auth.
      requestCert: true,
      rejectUnauthorized: false,
    }, app);
    await new Promise((res) => {
      lanServer.once('error', (e) => {
        if (!silent) process.stderr.write(`[scope] HTTPS on ${lanIp}:${actualPort} unavailable: ${e.message}\n`);
        lanServer = null;
        res();
      });
      lanServer.listen(actualPort, lanIp, res);
    });
  }

  const server = loopbackServer;
  const localUrl = `http://localhost:${actualPort}`;

  // Bonjour holds the event loop open and opens UDP multicast sockets, so
  // tests pass discoverable: false to skip it. In prod, the default flow
  // publishes both the scope.local hostname and the _scope._tcp service.
  const bonjour = discoverable ? new Bonjour() : null;
  // TXT record:
  //   path=/       — where the UI / API lives
  //   auth=...     — comma-separated supported auth schemes. We always
  //                  support bearer (browser cookie). Under HTTPS we also
  //                  support mtls (client cert).
  //   scheme=...   — http | https, so SwiftUI clients know which URL
  //                  scheme to use.
  //   ca_fp=...    — SHA-256 of the local CA (lowercase hex, no colons).
  //                  Native clients pin this when first discovering a
  //                  Scope on the LAN, preventing a malicious peer from
  //                  spoofing scope.local with their own CA.
  // host + port duplicate the SRV record, but NWBrowser doesn't expose the
  // resolved SRV target to clients without a full NWConnection.start(), so
  // native clients read them from TXT directly. We publish the raw LAN IP
  // (rather than `scope.local`) so iOS clients don't depend on mDNS host
  // resolution from the device — our CA pinning bypasses TLS hostname checks
  // anyway.
  const advertisedHost = lanIp || 'scope.local';
  const txt = { path: '/', host: advertisedHost, port: String(actualPort) };
  if (tlsCtx && lanServer) {
    txt.scheme = 'https';
    txt.auth = 'bearer,mtls';
    txt.ca_fp = fingerprintHex(tlsCtx.ca.certPem);
  } else {
    txt.scheme = 'http';
    txt.auth = 'bearer';
  }
  const advert = bonjour
    ? bonjour.publish({
        name: 'scope',
        host: 'scope.local',
        type: 'scope',
        protocol: 'tcp',
        port: actualPort,
        txt,
      })
    : null;

  log(chalk.green('✓') + ` scope running`);
  log(chalk.gray('  local:   ') + chalk.bold(localUrl));
  if (lanServer) {
    log(chalk.gray('  network: ') + chalk.bold(`https://scope.local:${actualPort}`) + chalk.gray(`  •  https://${lanIp}:${actualPort}`));
    log(chalk.yellow('  ↳ open network URL once to set an auth cookie:'));
    log('    ' + chalk.bold(`https://scope.local:${actualPort}/?token=${token}`));
    log(chalk.gray('  CA fingerprint (SHA-256): ') + chalk.gray(tlsCtx.ca.fingerprint));
  }
  const list = mgr.list();
  log(chalk.gray(`  workspaces: ${list.length}`));
  for (const w of list) {
    log(chalk.gray(`    • ${w.label}  ${chalk.dim(w.scope_dir)}`));
  }
  if (!quiet) log(chalk.gray('  press Ctrl-C to stop'));
  if (openBrowser) open(localUrl).catch(() => {});

  server._workspaces = mgr;
  server._bonjour = bonjour;
  server._bonjourAdvert = advert;
  server._tls = tlsCtx;
  server._lanServer = lanServer;
  server._pairing = pairing;
  const origClose = server.close.bind(server);
  server.close = (cb) => {
    try { advert?.stop?.(); } catch {}
    try { bonjour?.unpublishAll(() => bonjour.destroy()); } catch {}
    try { lanServer?.close(); } catch {}
    return origClose(cb);
  };
  return server;
}

function pickLanIp() {
  const ifs = networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}
