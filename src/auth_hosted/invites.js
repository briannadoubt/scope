/**
 * Invite flow + member management (SCP-190).
 *
 * An owner adds people to a project (a project IS a tenant, ADR 0003 §3) by
 * minting a single-use invite code, optionally addressed to an email. The CODE
 * is the credential — like api_keys.key_hash, only sha-256(code) is stored and
 * the plaintext is returned exactly once (the UI turns it into a share link).
 * Accepting grants membership at the invite's role, but NEVER downgrades an
 * existing higher role. The members endpoints back the web UI's member panel
 * (list / change role / remove / leave) with a LAST_OWNER guard so a project
 * can never be orphaned.
 *
 * Everything here assumes the cloud credential gate (cloud-auth.js
 * hostedAuthMiddleware) already ran, so `req.principal.accountId` exists.
 * Mount AFTER that gate and after express.json().
 */
import { randomBytes, createHash } from 'node:crypto';
import { serverError } from '../http-errors.js';
import express from 'express';

import { ROLES, ROLE_RANK } from './schema.js';
import { setMembership, getRole, roleSatisfies, changeRoleGuarded, removeMemberGuarded } from './membership.js';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function nowIso(now) { return new Date(Number.isFinite(now) ? now : Date.now()).toISOString(); }
function inviteId() { return `inv_${randomBytes(9).toString('hex')}`; }

/** sha-256 hex of an invite code (mirror of apikeys.js hashKey — never store plaintext). */
export function hashInviteCode(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}

/**
 * Param-based tenant role gate. Mirrors tenancy.js requireTenantRole semantics
 * EXACTLY (404 for non-members so board existence isn't disclosed, 403 for an
 * insufficient role, sets req.tenantId/req.tenantRole) — but resolves the
 * tenant from the route param (/api/projects/:tenantId/…) instead of the
 * header/query/claim. Local on purpose: tenancy.js is owned by parallel work.
 *
 * @param {import('pg').Pool} pool
 * @param {'viewer'|'member'|'owner'} minRole
 */
function requireParamTenantRole(pool, minRole) {
  return async (req, res, next) => {
    const accountId = req.principal?.accountId;
    if (!accountId) return res.status(401).json({ error: 'unauthorized' });
    const tenantId = req.params.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'no project selected', code: 'NO_PROJECT' });
    try {
      const role = await getRole(pool, tenantId, accountId);
      if (!role || !roleSatisfies(role, minRole)) {
        // 404 (not 403) when the subject isn't a member at all — don't disclose
        // that a board exists to someone with no access to it (tenancy.js).
        return res
          .status(role ? 403 : 404)
          .json({ error: role ? 'insufficient role' : 'no such project', code: role ? 'FORBIDDEN_ROLE' : 'NO_PROJECT' });
      }
      req.tenantId = tenantId;
      req.tenantRole = role;
      next();
    } catch (e) {
      serverError(res, e);
    }
  };
}

/**
 * Member-management + invite endpoints (SCP-190). All routes require
 * `req.principal` (mount after the credential gate). Returns an express.Router.
 *
 *   GET    /api/projects/:tenantId/members            >= viewer
 *   PATCH  /api/projects/:tenantId/members/:accountId owner (LAST_OWNER guard)
 *   DELETE /api/projects/:tenantId/members/:accountId owner, or self-leave
 *   POST   /api/projects/:tenantId/invites            owner
 *   GET    /api/projects/:tenantId/invites            owner (never leaks code/hash)
 *   DELETE /api/projects/:tenantId/invites/:id        owner (idempotent revoke)
 *   POST   /api/invites/accept                        any authenticated principal
 *
 * @param {{ pool: import('pg').Pool }} deps
 */
export function membersRouter({ pool }) {
  const r = express.Router();

  /* -------------------------------- members ------------------------------- */

  // List a project's members. Any member (>= viewer) may see who else is on the board.
  r.get('/api/projects/:tenantId/members', requireParamTenantRole(pool, 'viewer'), async (req, res) => {
    try {
      const rows = (await pool.query(
        `SELECT m.account_id, a.email, a.name, m.role, m.created_at
           FROM memberships m JOIN accounts a ON a.id = m.account_id
          WHERE m.tenant_id=$1 ORDER BY m.created_at, m.account_id`, [req.tenantId]
      )).rows;
      res.json(rows);
    } catch (e) {
      serverError(res, e);
    }
  });

  // Change a member's role. Owner only. A project must always keep >= 1 owner.
  r.patch('/api/projects/:tenantId/members/:accountId', requireParamTenantRole(pool, 'owner'), async (req, res) => {
    try {
      const role = req.body && req.body.role;
      if (!ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of ${ROLES.join('|')}`, code: 'INVALID_ROLE' });
      }
      const target = req.params.accountId;
      // Atomic owner-guard (SCP-210): serialize concurrent demotions so a board
      // can't be left with zero owners.
      await changeRoleGuarded(pool, { tenantId: req.tenantId, accountId: target, role });
      res.json({ account_id: target, role });
    } catch (e) {
      if (e.code === 'LAST_OWNER') return res.status(400).json({ error: 'cannot demote the last owner', code: 'LAST_OWNER' });
      if (e.code === 'NO_MEMBER') return res.status(404).json({ error: 'no such member', code: 'NO_MEMBER' });
      serverError(res, e);
    }
  });

  // Remove a member. Owner only — except anyone may remove THEMSELVES (leave
  // the project). Either way the last owner can never be removed.
  r.delete('/api/projects/:tenantId/members/:accountId', requireParamTenantRole(pool, 'viewer'), async (req, res) => {
    try {
      const target = req.params.accountId;
      const self = target === req.principal.accountId;
      if (!self && req.tenantRole !== 'owner') {
        return res.status(403).json({ error: 'insufficient role', code: 'FORBIDDEN_ROLE' });
      }
      // Atomic owner-guard (SCP-210): last owner can never be removed, even
      // under a concurrent self-leave + demote race.
      await removeMemberGuarded(pool, { tenantId: req.tenantId, accountId: target }); // idempotent
      res.json({ ok: true });
    } catch (e) {
      if (e.code === 'LAST_OWNER') return res.status(400).json({ error: 'cannot remove the last owner', code: 'LAST_OWNER' });
      serverError(res, e);
    }
  });

  /* -------------------------------- invites ------------------------------- */

  // Mint a single-use invite code. Owner only — which also covers "only an
  // owner can grant owner" (no lesser role reaches this route at all). The
  // plaintext code is returned ONCE; only its sha-256 is stored.
  r.post('/api/projects/:tenantId/invites', requireParamTenantRole(pool, 'owner'), async (req, res) => {
    try {
      const body = req.body || {};
      const role = body.role === undefined || body.role === null ? 'member' : body.role;
      if (!ROLES.includes(role)) {
        return res.status(400).json({ error: `role must be one of ${ROLES.join('|')}`, code: 'INVALID_ROLE' });
      }
      const email = body.email === undefined || body.email === null ? null : body.email;
      if (email !== null && (typeof email !== 'string' || !email.trim())) {
        return res.status(400).json({ error: 'email must be a non-empty string', code: 'INVALID_EMAIL' });
      }
      const code = randomBytes(16).toString('base64url'); // unguessable, single-use
      const ts = nowIso();
      const expiresAt = nowIso(Date.now() + INVITE_TTL_MS);
      await pool.query(
        `INSERT INTO invites (id, tenant_id, email, role, code_hash, created_by, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [inviteId(), req.tenantId, email ? email.trim() : null, role, hashInviteCode(code),
          req.principal.accountId, ts, expiresAt]
      );
      // The code is shown exactly once — the UI turns it into a shareable link.
      res.status(201).json({ code, email: email ? email.trim() : null, role, expires_at: expiresAt });
    } catch (e) {
      serverError(res, e);
    }
  });

  // List PENDING invites (not accepted/revoked/expired). Owner only.
  // NEVER returns the code or its hash.
  r.get('/api/projects/:tenantId/invites', requireParamTenantRole(pool, 'owner'), async (req, res) => {
    try {
      const rows = (await pool.query(
        `SELECT id, email, role, created_at, expires_at
           FROM invites
          WHERE tenant_id=$1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > $2
          ORDER BY created_at, id`, [req.tenantId, nowIso()]
      )).rows;
      res.json(rows);
    } catch (e) {
      serverError(res, e);
    }
  });

  // Revoke an invite. Owner only. Idempotent — revoking twice (or revoking an
  // already-accepted invite) is a no-op success.
  r.delete('/api/projects/:tenantId/invites/:id', requireParamTenantRole(pool, 'owner'), async (req, res) => {
    try {
      await pool.query(
        `UPDATE invites SET revoked_at=$3 WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL`,
        [req.params.id, req.tenantId, nowIso()]
      );
      res.json({ ok: true });
    } catch (e) {
      serverError(res, e);
    }
  });

  // Redeem an invite code. ANY authenticated principal — the code IS the
  // credential; the invite's email is advisory addressing only (a mismatch is
  // flagged, not rejected). Single-use: the accepted_at mark is an atomic
  // conditional UPDATE so two racing accepts can't both win.
  r.post('/api/invites/accept', async (req, res) => {
    try {
      const code = req.body && req.body.code;
      if (typeof code !== 'string' || !code) {
        return res.status(400).json({ error: 'code required', code: 'INVITE_INVALID' });
      }
      const accountId = req.principal?.accountId;
      if (!accountId) return res.status(401).json({ error: 'unauthorized' });

      const invite = (await pool.query(
        `SELECT i.*, p.name AS project_name
           FROM invites i JOIN projects p ON p.tenant_id = i.tenant_id
          WHERE i.code_hash=$1`, [hashInviteCode(code)]
      )).rows[0];
      if (!invite || invite.revoked_at || invite.accepted_at) {
        return res.status(400).json({ error: 'invite is invalid', code: 'INVITE_INVALID' });
      }
      const now = nowIso();
      if (invite.expires_at <= now) {
        return res.status(400).json({ error: 'invite has expired', code: 'INVITE_EXPIRED' });
      }

      // Consume the invite atomically (single-use even under a race).
      const consumed = await pool.query(
        `UPDATE invites SET accepted_at=$2, accepted_by=$3
          WHERE id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [invite.id, now, accountId]
      );
      if (consumed.rowCount === 0) {
        return res.status(400).json({ error: 'invite is invalid', code: 'INVITE_INVALID' });
      }

      // Grant membership at the invite's role — but NEVER downgrade an existing
      // higher role (an owner accepting a member invite stays owner).
      const existing = await getRole(pool, invite.tenant_id, accountId);
      const role = existing && ROLE_RANK[existing] >= ROLE_RANK[invite.role] ? existing : invite.role;
      await setMembership(pool, { tenantId: invite.tenant_id, accountId, role });

      const out = { tenantId: invite.tenant_id, role, name: invite.project_name };
      if (invite.email) {
        const acct = (await pool.query('SELECT email FROM accounts WHERE id=$1', [accountId])).rows[0];
        if (!acct || String(acct.email).toLowerCase() !== String(invite.email).toLowerCase()) {
          out.email_mismatch = true; // advisory only — the code is the credential
        }
      }
      res.json(out);
    } catch (e) {
      serverError(res, e);
    }
  });

  return r;
}
