import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { watch } from 'node:fs';
import open from 'open';
import chalk from 'chalk';
import { bus, emitChange } from './events.js';
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

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Start the local web server.
 *
 * @param {object} opts
 * @param {Database} opts.db           - open SQLite database
 * @param {string} opts.scopeDir       - path to .scope dir
 * @param {number} opts.port           - port to listen on
 * @param {boolean} opts.open          - open browser after start
 * @param {() => any} [opts.mcpFactory] - if provided, mounts MCP HTTP transport at /mcp.
 *                                       Should return a freshly-built McpServer for each request
 *                                       (stateless mode — see scope mcp HTTP).
 */
export function startServer({
  db,
  scopeDir,
  port,
  open: openBrowser,
  mcpFactory,
  serveUi = true,
}) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  /* ---------- MCP (mounted before static catch-all) ---------- */

  if (mcpFactory) mountMcp(app, mcpFactory);

  /* ---------- meta ---------- */

  app.get('/api/meta', (_req, res) => {
    res.json({
      scope_dir: scopeDir,
      statuses: SCHEMA_STATUSES,
      priorities: SCHEMA_PRIORITIES,
      ticket_types: SCHEMA_TICKET_TYPES,
      relation_types: SCHEMA_RELATION_TYPES,
    });
  });

  /* ---------- projects ---------- */

  app.get('/api/projects', (_req, res) => res.json(listProjects(db)));

  app.get('/api/projects/:id', (req, res) => {
    const p = getProject(db, req.params.id);
    if (!p) return res.status(404).json({ error: 'not found' });
    const tickets = listTickets(db, { projectIdOrKey: p.id });
    const epics = tickets
      .filter((t) => t.type === 'epic')
      .map((e) => ({ ...e, progress: epicProgress(db, e.id) }));
    res.json({ ...p, tickets, epics });
  });

  app.post('/api/projects', (req, res) => {
    try {
      const p = createProject(db, req.body);
      res.status(201).json(p);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch('/api/projects/:id', (req, res) => {
    try {
      const p = updateProject(db, req.params.id, req.body);
      res.json(p);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /* ---------- tickets ---------- */

  app.get('/api/tickets', (req, res) => {
    const { project, type, status, parent, assignee } = req.query;
    const filter = {
      projectIdOrKey: project,
      type,
      status,
      assignee,
    };
    if (parent !== undefined) filter.parentId = parent === 'none' ? null : parent;
    res.json(listTickets(db, filter));
  });

  app.get('/api/tickets/:id', (req, res) => {
    const t = getTicket(db, req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({
      ...t,
      relations: listRelations(db, t.id),
      comments: listComments(db, t.id),
      history: listHistory(db, t.id),
      children: t.type === 'epic' ? listEpicChildren(db, t.id) : [],
      progress: t.type === 'epic' ? epicProgress(db, t.id) : null,
    });
  });

  app.post('/api/tickets', (req, res) => {
    try {
      const t = createTicket(db, req.body);
      res.status(201).json(t);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch('/api/tickets/:id', (req, res) => {
    try {
      const body = { ...req.body };
      const by = body.__by;
      delete body.__by;
      const t = updateTicket(db, req.params.id, body, by);
      res.json(t);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/tickets/:id', (req, res) => {
    const ok = deleteTicket(db, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: req.params.id });
  });

  /* ---------- relations ---------- */

  app.get('/api/tickets/:id/relations', (req, res) => {
    res.json(listRelations(db, req.params.id));
  });

  app.post('/api/tickets/:id/relations', (req, res) => {
    try {
      const { to, type } = req.body;
      const rels = addRelation(db, req.params.id, to, type);
      res.status(201).json(rels);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/tickets/:id/relations', (req, res) => {
    try {
      const { to, type } = req.body;
      removeRelation(db, req.params.id, to, type);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /* ---------- comments ---------- */

  app.get('/api/tickets/:id/comments', (req, res) => {
    res.json(listComments(db, req.params.id));
  });

  app.post('/api/tickets/:id/comments', (req, res) => {
    try {
      const c = addComment(db, req.params.id, req.body.body, req.body.author);
      res.status(201).json(c);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /* ---------- realtime: SSE + cross-process fs.watch ---------- */

  // Track the SQLite data_version so we only emit "external" events when
  // another process actually wrote (not from our own in-process emits).
  let lastDataVersion = readDataVersion(db);
  const onFsChange = debounce(() => {
    const v = readDataVersion(db);
    if (v !== lastDataVersion) {
      lastDataVersion = v;
      emitChange({ type: 'external', source: 'fs-watch' });
    }
  }, 80);

  let watcher;
  try {
    watcher = watch(scopeDir, { persistent: false }, (_event, filename) => {
      if (!filename || !String(filename).startsWith('scope.db')) return;
      onFsChange();
    });
  } catch (e) {
    console.error(chalk.yellow('fs.watch failed (cross-process updates disabled):'), e.message);
  }

  // Bump lastDataVersion on every in-process change so the watcher doesn't
  // re-emit for our own writes (the UI would still de-dupe via hash, but
  // saving the extra round-trip is cleaner).
  const inProcessTracker = () => { lastDataVersion = readDataVersion(db); };
  bus.on('change', inProcessTracker);

  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ scope_dir: scopeDir })}\n\n`);

    const send = (detail) => {
      res.write(`event: change\ndata: ${JSON.stringify(detail)}\n\n`);
    };
    bus.on('change', send);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 20000);

    req.on('close', () => {
      bus.off('change', send);
      clearInterval(keepalive);
    });
  });

  /* ---------- board ---------- */

  app.get('/api/board', (req, res) => {
    const { project, epic } = req.query;
    const tickets = listTickets(db, {
      projectIdOrKey: project,
      parentId: epic,
    });
    const buckets = Object.fromEntries(SCHEMA_STATUSES.map((s) => [s, []]));
    for (const t of tickets) {
      if (buckets[t.status]) buckets[t.status].push(t);
    }
    res.json({ columns: SCHEMA_STATUSES, buckets });
  });

  /* ---------- static UI ---------- */

  if (serveUi) {
    app.use(express.static(join(__dirname, 'web')));
    app.get('*', (_req, res) => {
      res.sendFile(join(__dirname, 'web', 'index.html'));
    });
  }

  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const url = `http://localhost:${port}`;
      if (serveUi) {
        console.log(chalk.green('✓') + ` scope ui running at ${chalk.bold(url)}`);
      }
      if (mcpFactory) {
        console.log(
          chalk.green('✓') +
            ` scope mcp endpoint at ${chalk.bold(url + '/mcp')} (streamable HTTP, stateless)`
        );
      }
      console.log(chalk.gray(`  db: ${scopeDir}`));
      console.log(chalk.gray('  press Ctrl-C to stop'));
      if (openBrowser && serveUi) open(url).catch(() => {});
      resolve(server);
    });
  });
}

/* SQLite's data_version pragma increments whenever any connection writes —
   even from a different process. We use it to dedupe fs.watch events. */
function readDataVersion(db) {
  const row = db.prepare('PRAGMA data_version').get();
  return row?.data_version ?? 0;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * Mount MCP streamable-HTTP endpoints on the Express app.
 *
 * Stateless: every request builds a fresh McpServer + transport pair, processes
 * the request, then tears them down. Concurrency is handled at the SQLite layer
 * (WAL mode, in repo.js). Many agents can post to /mcp simultaneously.
 */
function mountMcp(app, mcpFactory) {
  const handleOnce = async (req, res) => {
    let mcp;
    let transport;
    try {
      const { StreamableHTTPServerTransport } = await import(
        '@modelcontextprotocol/sdk/server/streamableHttp.js'
      );
      mcp = mcpFactory();
      transport = new StreamableHTTPServerTransport({});
      res.on('close', () => {
        try { transport?.close(); } catch {}
        try { mcp?.close?.(); } catch {}
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(chalk.red('MCP error:'), err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err?.message || 'Internal MCP error' },
          id: null,
        });
      }
    }
  };
  app.post('/mcp', handleOnce);
  app.get('/mcp', handleOnce);
  app.delete('/mcp', handleOnce);
}
