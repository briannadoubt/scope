/**
 * Tenancy resolution + role gating (SCP-187 / SCP-188).
 *
 * A project IS a tenant IS a board (ADR 0003 §3, SCP-186). In cloud mode the
 * active board for a request is resolved from the AUTHENTICATED SUBJECT — never
 * from an unauthenticated client-supplied workspace header (ADR 0003 §4):
 *
 *   tenant = X-Scope-Project header  (explicit board selector)
 *          | ?project= query param
 *          | the session/API-key's tenant_id claim  (default board)
 *
 * …and the subject must hold the required role on that tenant, checked against
 * the memberships table (membership.hasRole). This is the only place cloud
 * requests pick a board, so isolation can't be bypassed by spoofing a header.
 */
import { hasRole, getRole } from './membership.js';

/**
 * The board the request is asking for: explicit selector, else the claim
 * default. The legacy X-Scope-Workspace header / ?workspace= param double as
 * selectors so the existing web app works per-tenant unchanged — accepting
 * them is safe because they only SELECT among boards; membership is always
 * validated against the authenticated subject (never header-derived tenancy).
 */
export function requestedTenant(req) {
  const pick = (v) => (typeof v === 'string' && v ? v : null);
  return (
    pick(req.headers['x-scope-project']) ||
    pick(req.query && req.query.project) ||
    pick(req.headers['x-scope-workspace']) ||
    pick(req.query && req.query.workspace) ||
    req.principal?.tenantId ||
    null
  );
}

/**
 * Express middleware: resolve the active tenant and require >= minRole on it.
 * On success sets `req.tenantId` and `req.tenantRole`. Otherwise 400 (no board
 * selected) / 403 (not a member or insufficient role).
 *
 * @param {import('pg').Pool} pool
 * @param {'viewer'|'member'|'owner'} minRole
 */
export function requireTenantRole(pool, minRole) {
  return async (req, res, next) => {
    const accountId = req.principal?.accountId;
    if (!accountId) return res.status(401).json({ error: 'unauthorized' });
    const tenantId = requestedTenant(req);
    if (!tenantId) return res.status(400).json({ error: 'no project selected', code: 'NO_PROJECT' });
    try {
      const role = await getRole(pool, tenantId, accountId);
      if (!role || !(await hasRole(pool, tenantId, accountId, minRole))) {
        // 404 (not 403) when the subject isn't a member at all — don't disclose
        // that a board exists to someone with no access to it.
        return res
          .status(role ? 403 : 404)
          .json({ error: role ? 'insufficient role' : 'no such project', code: role ? 'FORBIDDEN_ROLE' : 'NO_PROJECT' });
      }
      req.tenantId = tenantId;
      req.tenantRole = role;
      next();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
}
