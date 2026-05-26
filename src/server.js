import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { networkInterfaces } from 'node:os';
import open from 'open';
import chalk from 'chalk';
import Bonjour from 'bonjour-service';
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
  listProjectHistory,
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
  const app = express();
  app.use(authMiddleware({ token, allowedHosts: lanHosts() }));
  app.use(express.json({ limit: '5mb' }));

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
    res.json({
      statuses: SCHEMA_STATUSES,
      priorities: SCHEMA_PRIORITIES,
      ticket_types: SCHEMA_TICKET_TYPES,
      relation_types: SCHEMA_RELATION_TYPES,
      hub: { port, workspaces: mgr.list() },
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

  /* ---------- history ---------- */

  app.get('/api/history', ws((req, res, w) => {
    const { project, limit, before, beforeId } = req.query;
    if (!project) return res.status(400).json({ error: 'project is required' });
    const rows = listProjectHistory(w.db, project, { limit, before, beforeId });
    res.json({ entries: rows, limit: rows.length, before: before ?? null });
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

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0');
    server.once('listening', () => {
      const actualPort = server.address().port;
      const localUrl = `http://localhost:${actualPort}`;
      const lanIp = pickLanIp();
      // Bonjour holds the event loop open and opens UDP multicast sockets, so
      // tests pass discoverable: false to skip it. In prod, the default flow
      // publishes both the scope.local hostname and the _scope._tcp service.
      const bonjour = discoverable ? new Bonjour() : null;
      const advert = bonjour
        ? bonjour.publish({
            name: 'scope',
            host: 'scope.local',
            type: 'scope',
            protocol: 'tcp',
            port: actualPort,
            txt: { path: '/', auth: 'bearer' },
          })
        : null;
      const prettyUrl = `http://scope.local:${port}`;
      const bookmarkUrl = `${prettyUrl}/?token=${token}`;
      log(chalk.green('✓') + ` scope running at ${chalk.bold(prettyUrl)}`);
      log(chalk.gray(`  also: ${localUrl}${lanIp ? `  •  http://${lanIp}:${port}` : ''}`));
      log(chalk.yellow('  ↳ bookmark this URL once (sets an auth cookie):'));
      log('    ' + chalk.bold(bookmarkUrl));
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
