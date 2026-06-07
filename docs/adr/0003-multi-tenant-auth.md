# ADR 0003 — Multi-tenant auth & identity model (SCP-122)

> Status: **accepted (design)**. The attribution half — events carry the human
> principal plus an optional acting model, rendered "{model} on behalf of
> {user}" — is **implemented** in SCP-128 (see `formatActor`, the event
> envelope `model` field, and the `X-Scope-By`/`X-Scope-Model` HTTP headers).
> The provider/session/tenancy pieces below are the accepted plan for the
> SCP-120 epic; they gate the sync push path ([ADR 0002](0002-sync-cursor-protocol.md))
> and bind to the storage isolation layer (SCP-124).

## Context

The current trust model is single-domain by construction and **cannot stretch**
to a multi-tenant public service:

- a single per-hub **bearer token**,
- **loopback bypass** (127.0.0.1 skips auth entirely),
- a LAN-scoped **self-signed CA** with mTLS device pairing,
- tenancy derived purely from a **client-supplied `X-Scope-Workspace` header**.

All four are safe only because there is exactly one trust domain on a LAN. A
hosted service has many mutually-distrusting tenants on shared infrastructure,
so identity, sessions, and tenant isolation must be rebuilt. This is the largest
genuinely-new surface in the epic and it touches every endpoint.

Validation (SCP-121) fixed the identity shape: the buyer runs **LLM agent
fleets**, and attribution must read "Opus 4.8 on behalf of Bri" — the human is
the principal, the agent is metadata.

## Decision

### 1. Identity providers

- **Humans (interactive):** OIDC against GitHub / Google / Apple, with optional
  email+password fallback. The dev audience already has these identities;
  OIDC removes password storage and most account-security surface.
- **Machines (non-interactive — CLI & agents):** per-user **API keys** (opaque,
  hashed at rest, named, revocable, optionally project-scoped). The key carries
  only the human principal; the acting-model string is supplied **per request**
  (`--model` / `SCOPE_MODEL` / `X-Scope-Model`), never baked into the credential.

### 2. Principal = human; agents act on behalf (implemented, SCP-128)

The authenticated principal is **always a human account**. Agents do not get
their own identities — they authenticate as the user and stamp the acting model.
Attribution renders "{model} on behalf of {user}". Rejected: per-agent /
per-chat identities (needless identity sprawl; the human is accountable).

### 3. Project = tenant = sync boundary

Accounts join **projects**; a project is both the sharing unit and the realtime/
sync boundary ("project structure -> authenticate -> syncing starts"). Roles:
`owner` / `member` / `viewer`. Sessions are short-lived JWT access tokens
carrying `sub` + project/role claims, plus long-lived rotating refresh tokens.

### 4. Server-enforced tenancy + on-upload authz

Tenancy is derived from the authenticated subject's claims, **never** from a
client-supplied header (the `X-Scope-Workspace` trust must not survive into the
hosted relay). On the sync push path (ADR 0002), reject any event whose
`actor` principal differs from the authenticated subject, or where the subject
lacks write role on the target project. The `tenant_id` claim shape is shared
with the storage isolation layer (SCP-124, Postgres RLS).

### 5. LAN mTLS retained as a separate local trust domain

The existing CA + device pairing (`pair.js`/`ca.js`/`devices.js`) stays intact
for the offline/local-hub story — it is self-contained and cloud-independent.
The hosted relay is a **new, parallel** auth path layered on top, not a
replacement. Loopback bypass stays local-only and never exists in a hosted
deployment.

## Consequences

- A real account/identity surface (the epic's biggest new build), but offline
  local use is unaffected — mTLS/loopback keep working with zero cloud dependency.
- Attribution is already live end-to-end (SCP-128), so the authz check in
  step 4 has a concrete `actor` shape to verify against.
- **Rejected alternatives:** per-agent identities; unifying mTLS with cloud auth
  (two different trust domains, keep them separate); trusting the workspace
  header server-side.
- **Deps:** SCP-124 (RLS keyed on the `tenant_id` claim defined here); SCP-123/
  SCP-134 (the push-path authz gate); child stories SCP-129..133.
