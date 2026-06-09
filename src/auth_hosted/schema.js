/**
 * Hosted-auth Postgres schema (SCP-130 + SCP-131).
 *
 * These tables back the hosted identity layer described in ADR 0003. They live
 * alongside the event-log / cache tables defined in src/pg/schema.js but are
 * defined here so the auth modules own their own DDL (the parallel agent that
 * owns src/pg/schema.js never has to know about auth tables). Integration adds
 * a single `ensureAuthSchema(pool)` call next to the existing `ensureSchema`.
 *
 * Identity model (ADR 0003):
 *  - accounts      — a HUMAN principal. The authenticated `sub` everywhere.
 *  - projects      — a project IS a tenant (the sync/sharing boundary). The
 *                    `tenant_id` here is the same string the event-log tables
 *                    key on (src/pg/store.js / replay.js).
 *  - memberships   — account×project with a role (owner|member|viewer).
 *  - api_keys      — per-account, named, revocable, optionally project-scoped
 *                    non-interactive credentials. Only the HASH is stored; the
 *                    plaintext is shown once at creation and never persisted.
 *  - refresh_tokens— long-lived rotating refresh tokens (SCP-129). Only a hash
 *                    is stored; rotation marks the old row used and chains a new
 *                    one so token theft is detectable (reuse of a rotated token).
 *
 * `ensureAuthSchema` is idempotent (CREATE ... IF NOT EXISTS), safe on boot.
 */

export const ROLES = Object.freeze(['owner', 'member', 'viewer']);

/** Role rank for "≥role" comparisons. Higher = more privilege. */
export const ROLE_RANK = Object.freeze({ viewer: 1, member: 2, owner: 3 });

export const AUTH_SCHEMA_SQL = /* sql */ `
-- a human principal ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id          text PRIMARY KEY,          -- internal account id (the JWT sub claim)
  email       text NOT NULL,
  name        text,
  provider    text,                      -- 'github' | 'google' | 'apple' | 'password'
  provider_sub text,                     -- the OIDC subject at that provider
  created_at  text NOT NULL,
  updated_at  text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts (lower(email));
-- one account per (provider, provider_sub) so repeat OIDC logins reuse it
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider
  ON accounts (provider, provider_sub) WHERE provider_sub IS NOT NULL;

-- a project IS a tenant (the sync boundary; tenant_id == event-log tenant_id) -
CREATE TABLE IF NOT EXISTS projects (
  tenant_id   text PRIMARY KEY,          -- shared with src/pg/* event tables
  name        text NOT NULL,
  created_by  text NOT NULL REFERENCES accounts(id),
  created_at  text NOT NULL,
  archived_at text                       -- non-null => archived (soft delete, SCP-192)
);

-- account × project membership with a role -----------------------------------
CREATE TABLE IF NOT EXISTS memberships (
  tenant_id  text NOT NULL REFERENCES projects(tenant_id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id)        ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','member','viewer')),
  created_at text NOT NULL,
  PRIMARY KEY (tenant_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_account ON memberships (account_id);

-- non-interactive credentials: per-account API keys (hashed at rest) ---------
CREATE TABLE IF NOT EXISTS api_keys (
  id          text PRIMARY KEY,          -- the key id (also the public prefix lookup)
  account_id  text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,             -- human label, e.g. "ci-laptop"
  key_hash    text NOT NULL,             -- sha-256(secret) hex; NEVER the plaintext
  tenant_id   text REFERENCES projects(tenant_id) ON DELETE CASCADE, -- NULL = all the account's projects
  created_at  text NOT NULL,
  last_used_at text,
  revoked_at  text                       -- non-null => revoked, rejected on verify
);
CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys (account_id);

-- long-lived rotating refresh tokens (SCP-129) -------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          text PRIMARY KEY,          -- token id (the public half of the token)
  account_id  text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,             -- sha-256(secret) hex; NEVER the plaintext
  expires_at  text NOT NULL,
  created_at  text NOT NULL,
  rotated_to  text,                      -- id of the successor token after rotation
  revoked_at  text                       -- non-null => logged out / reuse-detected
);
CREATE INDEX IF NOT EXISTS idx_refresh_account ON refresh_tokens (account_id);

-- single-use project invites (SCP-190) ---------------------------------------
-- An owner mints a code; anyone presenting the code joins at the invite's role.
-- Like api_keys, only sha-256(code) is stored — the plaintext is shown ONCE.
CREATE TABLE IF NOT EXISTS invites (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES projects(tenant_id) ON DELETE CASCADE,
  email       text,                      -- advisory addressing; the CODE is the credential
  role        text NOT NULL CHECK (role IN ('owner','member','viewer')),
  code_hash   text NOT NULL UNIQUE,      -- sha-256(code) hex; NEVER the plaintext
  created_by  text NOT NULL REFERENCES accounts(id),
  created_at  text NOT NULL,
  expires_at  text NOT NULL,
  revoked_at  text,                      -- non-null => revoked, accept rejected
  accepted_at text,                      -- non-null => consumed (single-use)
  accepted_by text                       -- account that redeemed the code
);
CREATE INDEX IF NOT EXISTS idx_invites_tenant ON invites (tenant_id);
`;

/**
 * Create every hosted-auth table/index if absent. Idempotent; safe on boot.
 *
 * Serialized under the same advisory-lock + transient-retry pattern as
 * src/pg/schema.js ensureSchema: many processes boot servers concurrently in
 * the test suite (and multi-instance deploys will too), and concurrent DDL on
 * shared tables can deadlock (40P01) with another process's data writes.
 * Upgrade ALTERs run only when actually needed so steady-state boots take no
 * exclusive locks at all.
 */
export async function ensureAuthSchema(clientOrPool) {
  const isPool = typeof clientOrPool.connect === 'function';
  for (let attempt = 1; ; attempt++) {
    const db = isPool ? await clientOrPool.connect() : clientOrPool;
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(826349002)');
      await db.query(AUTH_SCHEMA_SQL);
      // Conditional upgrades for deployments created before a column existed.
      const hasArchived = (await db.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name='projects' AND column_name='archived_at'`
      )).rowCount > 0;
      if (!hasArchived) await db.query('ALTER TABLE projects ADD COLUMN archived_at text');
      await db.query('COMMIT');
      return;
    } catch (err) {
      try { await db.query('ROLLBACK'); } catch {}
      if ((err.code === '40P01' || err.code === '40001') && attempt < 6) {
        await new Promise((r) => setTimeout(r, 25 * attempt));
        continue;
      }
      throw err;
    } finally {
      if (isPool) db.release();
    }
  }
}

/** Drop every hosted-auth table (tests only). */
export async function dropAuthSchema(clientOrPool) {
  await clientOrPool.query(`
    DROP TABLE IF EXISTS invites, refresh_tokens, api_keys, memberships, projects, accounts CASCADE;
  `);
}
