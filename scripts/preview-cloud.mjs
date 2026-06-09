// Dev-only launcher: run the hub in CLOUD mode so the public marketing site
// renders at / (the local/LAN path serves only the app, by design). Used by the
// Claude preview pane to visually check the public site. Throwaway workspace.
//
//   node scripts/preview-cloud.mjs <port>            # cloud, shared-token (no hosted auth)
//   node scripts/preview-cloud.mjs <port> hosted     # cloud + hosted auth (needs local Postgres)
//
// In `hosted` mode it points at the docker-compose Postgres, enables hosted
// auth, seeds a demo account + project, mints a session JWT, and writes it to
// /tmp/scope-hosted-session.txt so a browser can inject it as the session
// cookie (no live GitHub round-trip needed to preview the signed-in app).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';

const port = Number(process.argv[2] || process.env.PORT || 4400);
const hosted = process.argv[3] === 'hosted';

process.env.SCOPE_CLOUD = '1';
process.env.SCOPE_TOKEN = process.env.SCOPE_TOKEN || 'preview-cloud-token-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'scope-preview-cloud-'));
process.env.SCOPE_DIR = join(dir, '.scope');

if (hosted) {
  process.env.SCOPE_PG_URL = process.env.SCOPE_PG_URL || 'postgres://scope:scope@localhost:5433/scope_test';
  process.env.SCOPE_JWT_SECRET = process.env.SCOPE_JWT_SECRET || 'preview-hosted-jwt-secret-0123456789';
}

// Initialize a throwaway workspace so cloud serve has something to manage.
execFileSync(process.execPath, ['bin/scope.js', 'init', '--key', 'DEMO', '--name', 'Demo'], { stdio: 'ignore' });

const mgr = new WorkspaceManager();
mgr.attach(process.env.SCOPE_DIR);
await startServer({ workspaces: mgr, port, cloud: true, tls: false, discoverable: false });

if (hosted) {
  // Seed an account + project and mint a session so the signed-in app can be
  // previewed without the live GitHub round-trip.
  const { getPool } = await import('../src/pg/pool.js');
  const { ensureAuthSchema } = await import('../src/auth_hosted/schema.js');
  const { upsertAccount, createProject, listMemberships } = await import('../src/auth_hosted/membership.js');
  const { mintAccessToken } = await import('../src/auth_hosted/sessions.js');
  const pool = getPool();
  await ensureAuthSchema(pool);
  const accountId = await upsertAccount(pool, { email: 'preview@scope.test', name: 'Preview User', provider: 'github', providerSub: 'preview-1' });
  if ((await listMemberships(pool, accountId)).length === 0) {
    await createProject(pool, { name: 'Preview project', ownerAccountId: accountId });
  }
  const m = (await listMemberships(pool, accountId))[0];
  const session = mintAccessToken({ sub: accountId, tenant_id: m?.tenant_id ?? null, role: m?.role ?? null });
  writeFileSync('/tmp/scope-hosted-session.txt', session);
  process.stdout.write(`hosted cloud preview on http://localhost:${port} (session written to /tmp/scope-hosted-session.txt)\n`);
} else {
  process.stdout.write(`cloud preview (public site) on http://localhost:${port}\n`);
}
