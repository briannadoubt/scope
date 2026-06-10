/**
 * Remote client (SCP-232/234) — turns a LOCAL `scope serve` into a full client
 * of a hosted project it's bound to. When a local board has a remote binding
 * (.scope/remote.json + a stored API key), the local server:
 *   - reports the binding in /api/meta (so the web UI unlocks the collab UI), and
 *   - PROXIES the collaboration endpoints (projects/members/invites/presence/
 *     keys) to the hosted hub with the key attached SERVER-SIDE — the browser
 *     keeps calling same-origin and the key never reaches it.
 * Ticket/board/sync data is NOT proxied; that stays local and converges via the
 * RemoteSyncAgent. Only the collaboration control plane is forwarded.
 */
import express from 'express';
import { resolveRemote, readCredential } from './remote-config.js';

/**
 * The effective remote binding for a local scope dir, or null if not bound.
 * @returns {{ url: string, project: string, key: string }|null}
 */
export function resolveBinding(scopeDir) {
  const { url, project } = resolveRemote(scopeDir);
  if (!url || !project) return null;
  const key = readCredential(url);
  if (!key) return null;
  return { url: url.replace(/\/$/, ''), project, key };
}

/**
 * Verify a binding against the hub: returns { connected, role, projectName }.
 * Hits GET /api/projects with the key and finds the bound project. Never throws.
 */
export async function probeRemote(binding, { fetchImpl = fetch } = {}) {
  if (!binding) return { connected: false, role: null, projectName: null };
  try {
    const res = await fetchImpl(`${binding.url}/api/projects`, {
      headers: { Authorization: `Bearer ${binding.key}` },
    });
    if (!res.ok) return { connected: false, role: null, projectName: null };
    const projects = await res.json();
    const p = Array.isArray(projects) ? projects.find((x) => (x.tenant_id || x.id) === binding.project) : null;
    return { connected: true, role: p?.role ?? null, projectName: p?.name ?? null };
  } catch {
    return { connected: false, role: null, projectName: null };
  }
}

// The collaboration control-plane paths that get forwarded to the remote. Ticket
// data, the board, and sync endpoints are deliberately NOT here.
const COLLAB_PATHS = [
  /^\/api\/projects$/,
  /^\/api\/projects\/[^/]+\/(members|invites|presence|aliases)(\/.*)?$/,
  /^\/api\/invites\/accept$/,
  /^\/auth\/keys(\/.*)?$/,
];

export function isCollabPath(p) {
  return COLLAB_PATHS.some((re) => re.test(p));
}

/**
 * Express router that forwards collab-path requests to the bound remote with the
 * API key. `getBinding()` is read per-request so connect/disconnect take effect
 * live. Non-collab paths fall through to the local handlers.
 *
 * @param {{ getBinding: () => ({url,project,key}|null), fetchImpl?: Function }} deps
 */
export function collabProxyRouter({ getBinding, fetchImpl = fetch }) {
  const r = express.Router();
  r.use(async (req, res, next) => {
    const binding = getBinding();
    if (!binding || !isCollabPath(req.path)) return next();
    try {
      const init = { method: req.method, headers: { Authorization: `Bearer ${binding.key}` } };
      if (!['GET', 'HEAD'].includes(req.method)) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(req.body ?? {});
      }
      const remoteRes = await fetchImpl(`${binding.url}${req.originalUrl}`, init);
      const text = await remoteRes.text();
      res.status(remoteRes.status);
      const ct = remoteRes.headers.get('content-type');
      if (ct) res.type(ct);
      res.send(text);
    } catch {
      res.status(502).json({ error: 'remote hub unavailable', code: 'REMOTE_DOWN' });
    }
  });
  return r;
}
