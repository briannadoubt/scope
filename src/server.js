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
import {
  hostedAuthEnabled, hostedAuthMiddleware, publicAuthRouter, apiKeyRouter,
  ensureHostedAuthReady, loginProviderConfigured, csrfGuard, hasValidSession,
} from './auth_hosted/cloud-auth.js';
import { authorizeUploadActors, statusForReject, ON_BEHALF_MARKER } from './auth_hosted/authz.js';

// Cap events accepted in a single sync push. Bounds the per-request work (and,
// on the interim file path, the replay cost) so one client can't wedge the node
// with an oversized batch (SCP-206). Generous — real pushes are far smaller.
const SYNC_MAX_BATCH = 2000;
import { requireTenantRole } from './auth_hosted/tenancy.js';
import { getRole, claimAlias, removeAlias, listAliases, allowedActorsFor } from './auth_hosted/membership.js';
import {
  listProjects, listProjectBoards, createProjectBoard, readBoard,
  renameProject, archiveProject,
} from './auth_hosted/tenant-board.js';
import { ensureReplica, refreshReplica, flushReplica, closeAllReplicas, evictReplica } from './auth_hosted/tenant-replica.js';
import { uploadEvents, pullEvents, existingEventIds } from './pg/store.js';
import { serverError } from './http-errors.js';
import { resolveBinding, probeRemote, collabProxyRouter } from './remote-client.js';
import { DEFAULT_CLOUD_URL, readCredential, readRemoteConfig, writeRemoteConfig, writeCredential, clearRemoteConfig, clearCredential } from './remote-config.js';
import { migrateEventsToLocal } from './workspace-storage.js';
import { startRemoteSync } from './remote-sync.js';

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
  sync = true, // SCP-232: auto-run the RemoteSyncAgent when the board is remote-bound
  discoverable = true,
  /**
   * Hosted/cloud mode (SCP-161). When true: bind 0.0.0.0:$PORT (reachable by
   * the platform proxy), skip Bonjour/mDNS and the LAN self-signed TLS (TLS
   * terminates at the cloud edge), and require the bearer token on EVERY
   * request (no loopback bypass — behind the proxy, requests can look like
   * loopback). Defaults from the SCOPE_CLOUD env var so fly.toml controls it.
   */
  cloud = process.env.SCOPE_CLOUD === '1',
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

  // Hosted multi-tenant auth (ADR 0003) activates ONLY in cloud mode with
  // Postgres + a JWT secret configured; until then the hub uses the interim
  // shared token, so deploying this code never breaks a not-yet-provisioned
  // hub. NEVER active on the local/LAN path (ADR 0003 §5). (SCP-171)
  const hostedAuth = hostedAuthEnabled(cloud);
  let pool = null;
  let hostedRuntime = null; // { pgBus } — set in the hosted branch, closed on shutdown
  if (hostedAuth) {
    pool = await ensureHostedAuthReady(); // create auth tables if absent (idempotent)
  }

  // Local-as-remote-client (SCP-232): a LOCAL (non-hosted) board can be bound to
  // a hosted project. When bound, this server reports the binding in /api/meta,
  // proxies the collaboration control-plane to the hub, and runs a RemoteSyncAgent
  // so the local board mirrors the project in realtime. The primary workspace is
  // whatever scopeDir was passed, else the first one the manager holds (the serve
  // path attaches via the manager, not the scopeDir param).
  const primaryWs = scopeDir ? mgr.attach(scopeDir) : [...mgr.workspaces.values()][0] || null;
  const primaryScopeDir = primaryWs?.scope_dir || null;
  let binding = (!cloud && primaryScopeDir) ? resolveBinding(primaryScopeDir) : null;
  let remoteProbe = { connected: false, role: null, projectName: null };
  let lastProbeAt = 0;
  let boundAgent = null;
  const refreshProbe = async () => { remoteProbe = await probeRemote(binding); lastProbeAt = Date.now(); };
  const startBoundSync = () => {
    if (boundAgent || cloud || sync === false || !binding || !primaryWs) return;
    boundAgent = startRemoteSync(primaryWs.db, primaryScopeDir, {
      remote: binding.url, project: binding.project, token: binding.key,
      onStatus: (s) => { remoteProbe = { ...remoteProbe, connected: s.connected }; },
    });
  };
  const stopBoundSync = () => { if (boundAgent) { try { boundAgent.stop(); } catch { /* ignore */ } boundAgent = null; } };
  // The committed remote.json pointer (key-independent) — drives the "linked but
  // not connected, connect to load" onboarding on a fresh clone (SCP-242).
  const remoteLinkPointer = () => {
    if (cloud || !primaryScopeDir) return null;
    const c = readRemoteConfig(primaryScopeDir);
    return c?.url && c?.project ? { url: c.url, project: c.project } : null;
  };
  if (binding) { refreshProbe().catch(() => {}); startBoundSync(); }

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

  // Unauthenticated liveness probe for the platform load balancer (SCP-155/161).
  // Mounted BEFORE auth so health checks need no credentials.
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  // --- Auth gate -----------------------------------------------------------
  // Three layers, increasing capability:
  //   local (non-cloud):  shared token + loopback bypass + LAN host allowlist
  //                       (+ mTLS device certs, inside authMiddleware). The
  //                       public site and /auth/* routes below are NEVER mounted
  //                       here — local serves only the app. UNCHANGED, ADR 0003 §5.
  //   cloud, interim:     shared token, no loopback bypass (today's hosted hub,
  //                       before Postgres/OAuth are provisioned).
  //   cloud + hostedAuth: per-user identity (session JWT or API key).
  if (cloud) {
    // Web-hardening headers on the cloud path (SCP-211): clickjacking + sniffing
    // + transport + referrer. CSP allows the SPA's own assets + inline styles
    // and the mermaid worker; tighten further as the app's inline usage shrinks.
    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
      );
      next();
    });
    // CSRF guard for cookie-authenticated mutations (SCP-204) — before the login
    // routes so /auth/refresh + /auth/logout are covered too.
    app.use(csrfGuard());
    // Signed-in visitors skip the marketing landing (SCP-231): send them
    // straight to the app. Logged-out visitors fall through to the public site.
    // (The local/LAN path never reaches here, so locally / is always the app.)
    app.get('/', (req, res, next) => (hasValidSession(req) ? res.redirect('/app') : next()));
    // Public marketing/docs site (cloud-only). Dynamically imported so the
    // local path never even loads it. Mounted BEFORE the gate so / /features
    // /docs are reachable unauthenticated; it owns no catch-all, so the app
    // and /api stay gated below.
    try {
      const { createPublicSiteRouter } = await import('./public-site/index.js');
      app.use(createPublicSiteRouter({ appPath: '/app', githubLoginPath: '/auth/login' }));
    } catch (e) {
      if (!quiet) process.stderr.write(`[hub] public site not mounted: ${e.message}\n`);
    }
    // Login flow, mounted BEFORE the gate in every cloud mode. When hosted auth
    // isn't fully provisioned (no pool/provider) it serves a friendly
    // "sign-in not enabled" page instead of letting /auth/login hit the 401 gate.
    app.use(publicAuthRouter({ pool, appPath: '/app' }));
  }
  if (hostedAuth) {
    // The credential gate: every request below needs a session JWT or API key.
    app.use(hostedAuthMiddleware({ pool }));
    // Authenticated API-key management (needs req.principal).
    app.use(apiKeyRouter({ pool }));

    // Milestone-B runtime modules (SCP-165): cross-node fan-out + quotas.
    // - pgBus: LISTEN/NOTIFY pointer messages ({tenant, cursor}) so an SSE
    //   client on THIS node hears about writes accepted by ANY node.
    // - rate limiter: per-principal/tenant token buckets on the whole API.
    // - connection tracker: per-tenant SSE ceiling.
    const { makePgBus } = await import('./realtime/bus.js');
    const { topicForTenant } = await import('./realtime/topics.js');
    const { checkEventQuota, recordEvents } = await import('./quota/quota.js');
    const { rateLimitMiddleware } = await import('./quota/ratelimit.js');
    const { createConnectionTracker } = await import('./quota/connections.js');
    const { getUsage } = await import('./quota/usage.js');
    const pgBus = makePgBus({ pool });
    hostedRuntime = { pgBus };
    const sseTracker = createConnectionTracker();
    // Presence registry (SCP-225): tenantId -> Map(accountId -> open-conn count).
    // In-process per node; fed by the /events SSE connect/close below.
    const presence = new Map();
    const presenceAdd = (t, a) => {
      let m = presence.get(t); if (!m) { m = new Map(); presence.set(t, m); }
      m.set(a, (m.get(a) || 0) + 1);
    };
    const presenceRemove = (t, a) => {
      const m = presence.get(t); if (!m) return;
      const n = (m.get(a) || 0) - 1;
      if (n > 0) m.set(a, n); else m.delete(a);
      if (m.size === 0) presence.delete(t);
    };
    const announce = (tenantId, cursor) => {
      pgBus.publish(topicForTenant(tenantId), { tenant: tenantId, cursor: cursor ?? null })
        .catch(() => {}); // fan-out is best-effort; pull-refresh is the backstop
    };
    app.use(rateLimitMiddleware({
      getPrincipal: (req) => req.principal?.accountId ?? null,
      // Key the per-tenant window ONLY on a resolved+authorized tenant (set by
      // the replica/requireTenantRole gate), else on the account — NEVER on the
      // raw ?project/?workspace selector, which is unauthenticated here and would
      // let one account fill another tenant's window (SCP-214). Tenantless
      // authed requests (/api/meta, /api/projects, invite accept) share the
      // principal's window.
      getTenant: (req) =>
        req.tenantId ?? (req.principal ? `acct:${req.principal.accountId}` : null),
    }));

    // Members + invites (SCP-190): per-project member list / role management /
    // invite create-accept-revoke. Self-gated per route; mounted BEFORE the
    // replica gate so /api/invites/accept works for principals who don't hold
    // a role on the target board yet (accepting is how they get one).
    const { membersRouter } = await import('./auth_hosted/invites.js');
    app.use(membersRouter({ pool }));

    // Tenant-scoped board API (SCP-186/187/188): a project IS a board, stored
    // per-tenant in Postgres. Mounted BEFORE the generic file/SQLite handlers so
    // hosted requests resolve their board from the authenticated subject's
    // project + role — never the X-Scope-Workspace header. Endpoints not yet
    // migrated fall through to the generic handlers (next increment).
    const tApi = express.Router();
    // The caller's projects (boards) + role on each.
    tApi.get('/api/projects', async (req, res) => {
      try { res.json(await listProjects(pool, req.principal.accountId)); }
      catch (e) { serverError(res, e); }
    });
    // Create a project + seed its board; the creator becomes owner.
    tApi.post('/api/projects', async (req, res) => {
      const name = req.body && req.body.name;
      if (!name) return res.status(400).json({ error: 'name required' });
      try { res.status(201).json(await createProjectBoard(pool, { accountId: req.principal.accountId, name })); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
    // Project lifecycle (SCP-192): rename / archive, owner only. The tenant
    // comes from the route param; ownership is validated against membership
    // (mirrors tenancy.js semantics: non-member 404, insufficient role 403).
    const ownerOf = (param) => async (req, res, next) => {
      try {
        const tenantId = req.params[param];
        const role = await getRole(pool, tenantId, req.principal.accountId);
        if (!role) return res.status(404).json({ error: 'no such project', code: 'NO_PROJECT' });
        if (role !== 'owner') return res.status(403).json({ error: 'insufficient role', code: 'FORBIDDEN_ROLE' });
        req.tenantId = tenantId;
        next();
      } catch (e) { serverError(res, e); }
    };
    tApi.patch('/api/projects/:tenantId', ownerOf('tenantId'), async (req, res) => {
      const name = req.body && req.body.name;
      if (!name) return res.status(400).json({ error: 'name required' });
      try { res.json(await renameProject(pool, req.tenantId, { accountId: req.principal.accountId, name })); }
      catch (e) { res.status(400).json({ error: e.message }); }
    });
    tApi.delete('/api/projects/:tenantId', ownerOf('tenantId'), async (req, res) => {
      try {
        const out = await archiveProject(pool, req.tenantId);
        evictReplica(req.tenantId); // drop the serving replica; data stays in PG
        res.json(out);
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    // Read the active board (>= viewer).
    tApi.get('/api/board', requireTenantRole(pool, 'viewer'), async (req, res) => {
      try { res.json(await readBoard(pool, req.tenantId)); }
      catch (e) { serverError(res, e); }
    });
    // Sync pull (>= viewer) / push (>= member) against the tenant's PG log.
    tApi.get('/api/sync/pull', requireTenantRole(pool, 'viewer'), async (req, res) => {
      try { res.json(await pullEvents(pool, req.tenantId, { since: req.query.since || null })); }
      catch (e) { serverError(res, e); }
    });
    // Actor aliases (SCP-184): map local event-actor names onto hosted accounts
    // so sync authz accepts a member's own local history. Claim is first-come
    // per project for yourself; the owner can force-reassign or remove any.
    tApi.get('/api/projects/:tenantId/aliases', async (req, res) => {
      // Authorize on the ROUTE PARAM, not the header/claim selector — otherwise
      // a viewer on board X could read board Y's alias->account map (SCP-200).
      try {
        const role = await getRole(pool, req.params.tenantId, req.principal.accountId);
        if (!role) return res.status(404).json({ error: 'no such project', code: 'NO_PROJECT' });
        res.json(await listAliases(pool, req.params.tenantId));
      } catch (e) { serverError(res, e); }
    });
    tApi.post('/api/projects/:tenantId/aliases', async (req, res) => {
      try {
        const tenantId = req.params.tenantId;
        const role = await getRole(pool, tenantId, req.principal.accountId);
        if (!role) return res.status(404).json({ error: 'no such project', code: 'NO_PROJECT' });
        if (role === 'viewer') return res.status(403).json({ error: 'insufficient role', code: 'FORBIDDEN_ROLE' });
        const { alias, account_id: target } = req.body || {};
        // Assigning someone ELSE's alias (or force-reassigning) is owner-only.
        const assigningOther = target && target !== req.principal.accountId;
        const force = req.body?.force === true;
        if ((assigningOther || force) && role !== 'owner') {
          return res.status(403).json({ error: 'insufficient role', code: 'FORBIDDEN_ROLE' });
        }
        const out = await claimAlias(pool, {
          tenantId, alias, accountId: target || req.principal.accountId, force,
        });
        res.status(201).json(out);
      } catch (e) {
        if (e.code === 'ALIAS_TAKEN') return res.status(409).json({ error: e.message, code: e.code });
        res.status(400).json({ error: e.message });
      }
    });
    tApi.delete('/api/projects/:tenantId/aliases/:alias', async (req, res) => {
      try {
        const tenantId = req.params.tenantId;
        const role = await getRole(pool, tenantId, req.principal.accountId);
        if (!role) return res.status(404).json({ error: 'no such project', code: 'NO_PROJECT' });
        const mine = (await listAliases(pool, tenantId))
          .find((a) => a.alias === req.params.alias)?.account_id === req.principal.accountId;
        if (!mine && role !== 'owner') {
          return res.status(403).json({ error: 'insufficient role', code: 'FORBIDDEN_ROLE' });
        }
        await removeAlias(pool, { tenantId, alias: req.params.alias });
        res.json({ ok: true });
      } catch (e) { serverError(res, e); }
    });

    tApi.post('/api/sync/push', requireTenantRole(pool, 'member'), async (req, res) => {
      const events = Array.isArray(req.body?.events) ? req.body.events : null;
      if (!events) return res.status(400).json({ error: 'body.events must be an array' });
      if (events.length > SYNC_MAX_BATCH) {
        return res.status(413).json({ error: `too many events in one push (max ${SYNC_MAX_BATCH})`, code: 'BATCH_TOO_LARGE' });
      }
      // Actor authz (SCP-172) + aliases (SCP-184), only on GENUINELY-NEW events
      // (SCP-230): a client pushes its whole log, which after a pull includes a
      // teammate's already-accepted events — those must not trip the actor gate
      // (they were validated when first uploaded). Dedup-then-authz.
      const existing = await existingEventIds(pool, req.tenantId, events.map((e) => e && e.id));
      const fresh = events.filter((e) => e && !existing.has(e.id));
      const allowedActors = await allowedActorsFor(pool, req.tenantId, req.principal.accountId);
      const verdict = authorizeUploadActors(fresh, req.principal.accountId, { allowedActors });
      if (!verdict.ok) return res.status(statusForReject(verdict.code)).json({ error: verdict.message, code: verdict.code });
      try {
        // Daily event quota (SCP-165) — hard stop at the tenant's plan cap.
        const quota = await checkEventQuota(pool, req.tenantId, events.length);
        if (!quota.allowed) {
          return res.status(429).json({
            error: 'event quota exceeded', code: 'QUOTA_EVENTS', used: quota.used, limit: quota.limit,
          });
        }
        const out = await uploadEvents(pool, req.tenantId, events);
        if (out.accepted.length) {
          recordEvents(pool, req.tenantId, out.accepted.length).catch(() => {});
          // Surface to live viewers here AND on every other node (pg bus); the
          // serving replica catches up on its next refresh-on-read.
          emitChange({ type: 'sync.applied', workspace: req.tenantId, applied: out.accepted.length });
          announce(req.tenantId, out.cursor);
        }
        res.json(out);
      }
      catch (e) { res.status(400).json({ error: `invalid event: ${e.message}` }); }
    });

    // Per-tenant usage vs plan limits (SCP-165).
    tApi.get('/api/usage', requireTenantRole(pool, 'viewer'), async (req, res) => {
      try { res.json(await getUsage(pool, req.tenantId, { connections: sseTracker })); }
      catch (e) { serverError(res, e); }
    });

    // The web app's workspace switcher reads /api/workspaces — in hosted mode a
    // "workspace" IS one of the caller's project boards (SCP-186/191). Server-
    // side dir attach/detach is meaningless (and unsafe) for hosted tenants.
    tApi.get('/api/workspaces', async (req, res) => {
      try { res.json(await listProjectBoards(pool, req.principal.accountId)); }
      catch (e) { serverError(res, e); }
    });
    tApi.post('/api/workspaces', (_req, res) =>
      res.status(403).json({ error: 'hosted boards are projects — create via POST /api/projects' }));
    tApi.delete('/api/workspaces/:id', (_req, res) =>
      res.status(403).json({ error: 'hosted boards are projects — manage via /api/projects' }));
    app.use(tApi);

    // Replica gate (SCP-186): every OTHER /api route — the entire existing REST
    // surface (tickets, relations, comments, history, search, board variants,
    // batch) — serves the caller's tenant via a local replica of the tenant's
    // canonical PG event log. GET needs >=viewer, mutations >=member. The
    // replica is refreshed (pull) before the handler and flushed (push) after a
    // mutation responds; uploadEvents' idempotency makes crash-retries safe.
    app.use('/api', (req, res, next) => {
      if (req.path === '/meta') return next(); // tenant-free: served generically
      const min = req.method === 'GET' ? 'viewer' : 'member';
      requireTenantRole(pool, min)(req, res, async () => {
        try {
          // Mutations consume event quota (SCP-165). The exact event count
          // isn't known until the handler runs; gate on headroom for one and
          // record the real count after the flush.
          if (req.method !== 'GET') {
            const quota = await checkEventQuota(pool, req.tenantId, 1);
            if (!quota.allowed) {
              return res.status(429).json({
                error: 'event quota exceeded', code: 'QUOTA_EVENTS', used: quota.used, limit: quota.limit,
              });
            }
          }
          const rep = await ensureReplica(pool, req.tenantId);
          await refreshReplica(pool, rep);
          req.tenantReplica = { id: req.tenantId, scope_dir: rep.scopeDir, db: rep.db, label: 'project' };
          if (req.method !== 'GET') {
            res.on('finish', () => {
              flushReplica(pool, rep)
                .then((r) => {
                  if (r.pushed) {
                    recordEvents(pool, req.tenantId, r.pushed).catch(() => {});
                    announce(req.tenantId, rep.cursor); // other nodes' viewers
                  }
                })
                .catch((e) => {
                  if (!quiet) process.stderr.write(`[hub] tenant flush failed (${req.tenantId}): ${e.message}\n`);
                });
            });
          }
          next();
        } catch (e) {
          serverError(res, e);
        }
      });
    });

    // SSE: a hosted viewer may only stream a board they belong to. The guard
    // validates the ?workspace= selector (a tenant id), enforces the per-tenant
    // connection ceiling, and bridges the cross-node bus: while this stream is
    // open the node LISTENs on the tenant's topic and replays pointer messages
    // into the local change bus, so writes accepted by OTHER nodes reach this
    // node's viewers (SCP-165 / SCP-146).
    app.use('/events', (req, res, next) => requireTenantRole(pool, 'viewer')(req, res, async () => {
      // acquire() ALWAYS returns an object ({allowed:false,…} on denial) — check
      // .allowed, not truthiness, or the ceiling is dead code (SCP-202).
      const lease = sseTracker.acquire(req.tenantId);
      if (!lease.allowed) {
        if (lease.retryAfterMs) res.setHeader('Retry-After', Math.ceil(lease.retryAfterMs / 1000));
        return res.status(429).json({ error: 'too many live connections for this project', code: 'QUOTA_CONNECTIONS' });
      }
      let off = null;
      try {
        off = await pgBus.subscribe(topicForTenant(req.tenantId), (payload) => {
          emitChange({ type: 'sync.applied', workspace: payload?.tenant || req.tenantId });
        });
      } catch { /* single-node still works via the in-process bus */ }
      // Presence (SCP-225): track who's connected to this board (this node) and
      // nudge viewers to refresh the roster on join/leave.
      presenceAdd(req.tenantId, req.principal.accountId);
      emitChange({ type: 'presence', workspace: req.tenantId });
      req.on('close', () => {
        lease.release();
        presenceRemove(req.tenantId, req.principal.accountId);
        emitChange({ type: 'presence', workspace: req.tenantId });
        if (off) Promise.resolve(off()).catch(() => {});
      });
      next();
    }));

    // Who is currently connected to a board (this node). In-process per node;
    // cross-node aggregation would ride the pgBus — deferred (SCP-225 stretch).
    // Authorize on the ROUTE PARAM, not the selector (avoid the SCP-200 IDOR
    // class): a non-member gets 404, never another board's roster.
    tApi.get('/api/projects/:tenantId/presence', async (req, res) => {
      try {
        const tenantId = req.params.tenantId;
        const role = await getRole(pool, tenantId, req.principal.accountId);
        if (!role) return res.status(404).json({ error: 'no such project', code: 'NO_PROJECT' });
        const ids = [...(presence.get(tenantId)?.keys() || [])];
        if (!ids.length) return res.json([]);
        const rows = (await pool.query(
          `SELECT id AS account_id, name, email FROM accounts WHERE id = ANY($1)`, [ids]
        )).rows;
        res.json(rows);
      } catch (e) { serverError(res, e); }
    });

    if (!quiet && !loginProviderConfigured()) {
      process.stderr.write('[hub] hosted auth on, but no login provider configured (API keys only)\n');
    }
  } else {
    // Interim cloud (cloud + shared token, no Postgres): still internet-facing,
    // so apply a per-IP rate limiter even though the hosted per-principal limiter
    // isn't available here (SCP-205). The local/LAN path stays unthrottled.
    if (cloud) {
      const { rateLimitMiddleware } = await import('./quota/ratelimit.js');
      app.use(rateLimitMiddleware({
        getPrincipal: (req) => req.ip || req.socket?.remoteAddress || 'anon',
        getTenant: (req) => `ip:${req.ip || req.socket?.remoteAddress || 'anon'}`,
      }));
    }
    app.use(
      cloud
        ? authMiddleware({ token, allowedHosts: [], trustLoopback: false })
        : authMiddleware({ token, allowedHosts: lanHosts() })
    );

    // Local-as-remote-client (SCP-232/234): forward the collaboration control-
    // plane to the bound hub with the API key attached server-side, so the web UI
    // (Members & sharing, invites, presence, keys) works against the remote while
    // ticket data stays local + synced. Non-collab paths fall through. Read live
    // (getBinding) so connect/disconnect take effect without a restart.
    if (!cloud) {
      app.use(collabProxyRouter({ getBinding: () => binding }));

      // Bind / unbind this board to a hosted project from the UI (SCP-236).
      // Loopback-only — same-machine control, like /api/pair/begin.
      const loopbackOnly = (req, res, next) => {
        const ip = req.socket?.remoteAddress || '';
        if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
        return res.status(403).json({ error: 'loopback only' });
      };
      // List the projects a (url, key) can see — lets the connect UI show a
      // picker after the user enters their hub + key, before binding (SCP-236).
      app.post('/api/remote/projects', loopbackOnly, async (req, res) => {
        let { url, key } = req.body || {};
        url = String(url || DEFAULT_CLOUD_URL).replace(/\/$/, '');
        key = key || readCredential(url);
        if (!key) return res.status(401).json({ error: 'sign in first with scope auth login or scope connect', code: 'AUTH_REQUIRED' });
        try {
          const r = await fetch(`${url}/api/projects`, { headers: { Authorization: `Bearer ${key}` } });
          if (!r.ok) return res.status(r.status === 401 ? 401 : 502).json({ error: r.status === 401 ? 'the hub rejected that key' : 'the hub is unreachable', code: r.status === 401 ? 'BAD_KEY' : 'REMOTE_DOWN' });
          res.json(await r.json());
        } catch { res.status(502).json({ error: 'the hub is unreachable', code: 'REMOTE_DOWN' }); }
      });
      app.post('/api/remote/connect', loopbackOnly, async (req, res) => {
        let { url, project, key, createName, gitignoreEvents } = req.body || {};
        url = String(url || DEFAULT_CLOUD_URL).replace(/\/$/, '');
        key = key || readCredential(url);
        if (!key) return res.status(401).json({ error: 'sign in first with scope auth login or scope connect', code: 'AUTH_REQUIRED' });
        if (!primaryScopeDir) return res.status(400).json({ error: 'no local workspace to bind' });
        try {
          // Born from a local repo (SCP-241): create a NEW project on the hub and
          // bind this workspace to it (the sync agent then pushes the board up).
          if (!project && createName) {
            const r = await fetch(`${url}/api/projects`, {
              method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: createName }),
            });
            if (!r.ok) return res.status(r.status === 401 ? 401 : 502).json({ error: r.status === 401 ? 'the hub rejected that key' : 'could not create the project on the hub', code: r.status === 401 ? 'BAD_KEY' : 'REMOTE_DOWN' });
            project = (await r.json()).tenantId;
          }
          if (!project) return res.status(400).json({ error: 'project (to join) or createName (to create) is required', code: 'NO_PROJECT' });

          writeRemoteConfig(primaryScopeDir, { url, project });
          writeCredential(url, key);
          // SCP-242/271: optionally migrate legacy repo events into quiet local
          // storage so the repo carries only marker/config files.
          if (gitignoreEvents) {
            migrateEventsToLocal(primaryScopeDir);
          }
          binding = resolveBinding(primaryScopeDir);
          stopBoundSync(); startBoundSync();
          await refreshProbe();
          if (!remoteProbe.connected) return res.status(502).json({ error: 'connected the config, but the hub did not accept the key', code: 'REMOTE_DOWN', remote: { url: binding.url, project: binding.project, connected: false } });
          res.json({ url: binding.url, project: binding.project, connected: true, role: remoteProbe.role, projectName: remoteProbe.projectName, gitignored: !!gitignoreEvents });
        } catch (e) { serverError(res, e); }
      });
      app.post('/api/remote/disconnect', loopbackOnly, (req, res) => {
        stopBoundSync();
        if (binding) clearCredential(binding.url);
        if (primaryScopeDir) clearRemoteConfig(primaryScopeDir);
        binding = null;
        remoteProbe = { connected: false, role: null, projectName: null };
        res.json({ ok: true });
      });
    }
  }

  /* ---------- workspace helpers ---------- */

  /**
   * Resolve the workspace for a request; on miss, send a 404 and return null.
   * Caller should `if (!ws) return;`
   */
  function resolveWs(req, res) {
    // Hosted requests already resolved + authorized their tenant board; the
    // replica IS the workspace for every downstream handler (SCP-186).
    if (req.tenantReplica) return req.tenantReplica;
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

  app.get('/api/meta', async (_req, res) => {
    const security = tlsCtx
      ? { scheme: 'https', auth: ['bearer', 'mtls'], ca_fingerprint: fingerprintHex(tlsCtx.ca.certPem) }
      : { scheme: 'http', auth: ['bearer'] };
    // SCP-233: the FIRST read of a bound server awaits the probe so connected/role
    // are accurate immediately; later reads use the cache + a throttled, async
    // refresh so they never block on the network.
    if (binding && !lastProbeAt) await refreshProbe().catch(() => {});
    else if (binding && Date.now() - lastProbeAt > 15000) refreshProbe().catch(() => {});
    res.json({
      version: PKG.version,
      statuses: SCHEMA_STATUSES,
      priorities: SCHEMA_PRIORITIES,
      ticket_types: SCHEMA_TICKET_TYPES,
      relation_types: SCHEMA_RELATION_TYPES,
      // Hosted: the hub's own volume workspaces are private plumbing — a
      // tenant's boards come from /api/workspaces (their projects) instead.
      hub: { port, workspaces: hostedAuth ? [] : enrichedWorkspaces() },
      security,
      // True when per-user hosted auth is active — the web UI uses this to show
      // the API-keys panel + sign-out (SCP-174). False on the local/LAN path.
      hosted: hostedAuth,
      // Remote binding (SCP-232/233): present when this LOCAL board is bound to a
      // hosted project. The web UI unlocks the collaboration UI on remote.connected
      // and targets remote.project for members/invites/presence (proxied).
      remote: binding
        ? { url: binding.url, project: binding.project, connected: remoteProbe.connected, role: remoteProbe.role, projectName: remoteProbe.projectName }
        : null,
      // The committed pointer (SCP-242), independent of whether a key is present.
      // Lets the UI show "this repo is linked to <project> — connect to load it"
      // on a fresh clone whose event log isn't committed and key isn't set yet.
      remoteLink: remoteLinkPointer(),
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
    if (incoming.length > SYNC_MAX_BATCH) {
      return res.status(413).json({ error: `too many events in one push (max ${SYNC_MAX_BATCH})`, code: 'BATCH_TOO_LARGE' });
    }
    // Validate the whole batch up front so a bad event lands nothing (atomic).
    try {
      for (const e of incoming) validateEvent(e);
    } catch (e) {
      return res.status(400).json({ error: `invalid event: ${e.message}` });
    }
    // Actor sanity on the LAN/interim path (SCP-213): even without per-user authz
    // here, reject events whose raw actor carries the rendered "{model} on behalf
    // of {user}" form — a well-formed event never stores that in the actor slot,
    // so its presence is an attempt to smuggle a display string as the principal.
    const rendered = incoming.find((e) => typeof e.actor === 'string' && e.actor.includes(ON_BEHALF_MARKER));
    if (rendered) {
      return res.status(400).json({ error: 'event actor must be a bare principal, not a rendered string', code: 'ACTOR_RENDERED' });
    }
    const dir = eventsDirForDb(w.db);
    // Read the log ONCE (SCP-206): build the dedup set from it and reuse the same
    // array for replay instead of re-reading the whole directory afterward.
    const existingEvents = readAllEvents(dir);
    const existing = new Set(existingEvents.map((e) => e.id));
    const accepted = [];
    const acceptedEvents = [];
    const duplicates = [];
    for (const e of incoming) {
      if (existing.has(e.id)) { duplicates.push(e.id); continue; }
      appendEvent(dir, e); // atomic tmp+rename; ULID filename => union semantics
      existing.add(e.id);
      accepted.push(e.id);
      acceptedEvents.push(e);
    }
    const all = existingEvents.concat(acceptedEvents);
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
      `event: hello\ndata: ${JSON.stringify({ workspaces: hostedAuth ? [] : enrichedWorkspaces() })}\n\n`
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
    // A keepalive must never keep the process alive on its own — otherwise an
    // SSE stream that's force-dropped (server.closeAllConnections on shutdown)
    // can leak this interval and hang process exit (SCP-232).
    keepalive.unref?.();

    req.on('close', () => {
      bus.off('change', send);
      clearInterval(keepalive);
    });
  });

  /* ---------- static UI ---------- */

  // Static assets (app.js, style.css, …) are served from the web/ root in both
  // modes so the SPA's relative asset URLs resolve. They sit AFTER the auth gate,
  // so in cloud mode they require a session.
  app.use(express.static(join(__dirname, 'web')));
  if (cloud) {
    // Cloud: the public landing owns '/', so the authed SPA lives at /app. A
    // scoped catch-all serves index.html for the app's client-side routes only.
    app.get('/app*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.sendFile(join(__dirname, 'web', 'index.html'));
    });
  } else {
    // Local: unchanged — the app is the whole site, served from '/'.
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.sendFile(join(__dirname, 'web', 'index.html'));
    });
  }

  // Resolve TLS configuration. `tls === false` keeps the legacy HTTP path
  // for tests; anything else (including undefined) means HTTPS on LAN. In cloud
  // mode the edge proxy terminates TLS, so we never load a local CA/leaf.
  let tlsCtx = null;
  if (tls !== false && !cloud) {
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
  // Cloud: bind all interfaces so the platform proxy can reach us. LAN/local:
  // bind loopback only and (below) add an HTTPS listener on the LAN IP.
  const bindHost = cloud ? '0.0.0.0' : '127.0.0.1';
  await new Promise((res, rej) => {
    loopbackServer.once('error', rej);
    loopbackServer.listen(port, bindHost, res);
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
  // No LAN discovery in cloud mode (no mDNS on a public host; the platform
  // routes by DNS/domain, not Bonjour).
  const bonjour = (discoverable && !cloud) ? new Bonjour() : null;
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
    try { lanServer?.closeAllConnections?.(); } catch {}
    try { stopBoundSync(); } catch {} // SCP-232: stop the remote-mirror agent
    if (hostedAuth) {
      try { closeAllReplicas(); } catch {}
      try { hostedRuntime?.pgBus?.close?.(); } catch {}
    }
    // Force-drop long-lived SSE/keepalive sockets so close() actually completes —
    // otherwise an open /events stream (e.g. a bound peer's sync agent) keeps the
    // server from finishing close and hangs shutdown (SCP-232). Clients reconnect.
    try { server.closeAllConnections?.(); } catch {}
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
