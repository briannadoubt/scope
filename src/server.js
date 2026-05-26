import express from 'express';
import http from 'node:http';
import https from 'node:https';
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
import { bus, wsContext } from './events.js';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  createTicket,
  getTicket,
  listTickets,
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
export function startServer({
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
      statuses: SCHEMA_STATUSES,
      priorities: SCHEMA_PRIORITIES,
      ticket_types: SCHEMA_TICKET_TYPES,
      relation_types: SCHEMA_RELATION_TYPES,
      hub: { port, workspaces: mgr.list() },
      security,
    });
  });

  /* ---------- workspaces ---------- */

  app.get('/api/workspaces', (_req, res) => res.json(mgr.list()));

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

  app.delete('/api/workspaces/:id', (req, res) => {
    const ok = mgr.detach(req.params.id);
    if (!ok) return res.status(404).json({ error: 'unknown workspace' });
    res.json({ detached: req.params.id });
  });

  /* ---------- projects ---------- */

  app.get('/api/projects', ws((_req, res, w) => res.json(listProjects(w.db))));

  app.get('/api/projects/:id', ws((req, res, w) => {
    const p = getProject(w.db, req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const tickets = listTickets(w.db, { projectIdOrKey: p.id });
    const epics = tickets
      .filter((t) => t.type === 'epic')
      .map((e) => ({ ...e, progress: epicProgress(w.db, e.id) }));
    res.json({ ...p, tickets, epics });
  }));

  app.post('/api/projects', ws((req, res, w) => {
    const p = createProject(w.db, req.body);
    res.status(201).json(p);
  }));

  app.patch('/api/projects/:id', ws((req, res, w) => {
    const p = updateProject(w.db, req.params.id, req.body);
    res.json(p);
  }));

  /* ---------- tickets ---------- */

  app.get('/api/tickets', ws((req, res, w) => {
    const { project, type, status, parent, assignee } = req.query;
    const filter = {
      projectIdOrKey: project,
      type,
      status,
      assignee,
    };
    if (parent !== undefined) filter.parentId = parent === 'none' ? null : parent;
    res.json(listTickets(w.db, filter));
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
    const t = createTicket(w.db, req.body);
    res.status(201).json(t);
  }));

  app.patch('/api/tickets/:id', ws((req, res, w) => {
    const body = { ...req.body };
    const by = body.__by;
    delete body.__by;
    const t = updateTicket(w.db, req.params.id, body, by);
    res.json(t);
  }));

  app.delete('/api/tickets/:id', ws((req, res, w) => {
    const ok = deleteTicket(w.db, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: req.params.id });
  }));

  /* ---------- relations ---------- */

  app.get('/api/tickets/:id/relations', ws((req, res, w) => {
    res.json(listRelations(w.db, req.params.id));
  }));

  app.post('/api/tickets/:id/relations', ws((req, res, w) => {
    const { to, type } = req.body;
    res.status(201).json(addRelation(w.db, req.params.id, to, type));
  }));

  app.delete('/api/tickets/:id/relations', ws((req, res, w) => {
    const { to, type } = req.body;
    removeRelation(w.db, req.params.id, to, type);
    res.json({ ok: true });
  }));

  /* ---------- comments ---------- */

  app.get('/api/tickets/:id/comments', ws((req, res, w) => {
    res.json(listComments(w.db, req.params.id));
  }));

  app.post('/api/tickets/:id/comments', ws((req, res, w) => {
    const c = addComment(w.db, req.params.id, req.body.body, req.body.author);
    res.status(201).json(c);
  }));

  /* ---------- board ---------- */

  app.get('/api/board', ws((req, res, w) => {
    const { project, epic } = req.query;
    const tickets = listTickets(w.db, {
      projectIdOrKey: project,
      parentId: epic,
    });
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
      `event: hello\ndata: ${JSON.stringify({ workspaces: mgr.list() })}\n\n`
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
    res.sendFile(join(__dirname, 'web', 'index.html'));
  });

  // Resolve TLS configuration. `tls === false` keeps the legacy HTTP path
  // for tests; anything else (including undefined) means HTTPS.
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

  const httpServer = tlsCtx
    ? https.createServer({
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
      }, app)
    : http.createServer(app);
  const scheme = tlsCtx ? 'https' : 'http';

  return new Promise((resolve, reject) => {
    const server = httpServer.listen(port, '0.0.0.0');
    server.once('listening', () => {
      const actualPort = server.address().port;
      const localUrl = `${scheme}://localhost:${actualPort}`;
      const lanIp = pickLanIp();
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
      const txt = { path: '/' };
      if (tlsCtx) {
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
      const prettyUrl = `${scheme}://scope.local:${port}`;
      const bookmarkUrl = `${prettyUrl}/?token=${token}`;
      log(chalk.green('✓') + ` scope running at ${chalk.bold(prettyUrl)}`);
      log(chalk.gray(`  also: ${localUrl}${lanIp ? `  •  ${scheme}://${lanIp}:${port}` : ''}`));
      log(chalk.yellow('  ↳ bookmark this URL once (sets an auth cookie):'));
      log('    ' + chalk.bold(bookmarkUrl));
      if (tlsCtx) {
        // HTTPS uses a self-signed local CA the browser doesn't trust yet.
        // First-run-style messaging: always show the fingerprint (so the
        // user can verify out-of-band when pairing); only nag about
        // `scope ca trust` if the CA was freshly created on this serve.
        log(chalk.gray('  CA fingerprint (SHA-256):'));
        log('    ' + chalk.gray(tlsCtx.ca.fingerprint));
        if (tlsCtx.ca.created) {
          log(chalk.yellow('  ↳ first run — browsers will show a cert warning until you trust the CA:'));
          log('    ' + chalk.bold('scope ca trust') + chalk.gray('     (System keychain, sudo — recommended)'));
          log('    ' + chalk.gray('scope ca trust --user') + chalk.gray('     (login keychain, no sudo)'));
        }
      }
      const list = mgr.list();
      log(chalk.gray(`  workspaces: ${list.length}`));
      for (const w of list) {
        log(chalk.gray(`    • ${w.label}  ${chalk.dim(w.scope_dir)}`));
      }
      if (!quiet) log(chalk.gray('  press Ctrl-C to stop'));
      if (openBrowser) open(bookmarkUrl).catch(() => open(localUrl + `/?token=${token}`).catch(() => {}));
      server._workspaces = mgr;
      server._bonjour = bonjour;
      server._bonjourAdvert = advert;
      server._tls = tlsCtx;
      server._pairing = pairing;
      const origClose = server.close.bind(server);
      server.close = (cb) => {
        try { advert?.stop?.(); } catch {}
        try { bonjour?.unpublishAll(() => bonjour.destroy()); } catch {}
        return origClose(cb);
      };
      resolve(server);
    });
    server.once('error', (err) => reject(err));
  });
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
