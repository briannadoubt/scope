// Dev-only launcher: run the hub in CLOUD mode so the public marketing site
// renders at / (the local/LAN path serves only the app, by design). Used by the
// Claude preview pane to visually check the public site. Throwaway workspace.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceManager } from '../src/workspaces.js';
import { startServer } from '../src/server.js';

const port = Number(process.argv[2] || process.env.PORT || 4400);
process.env.SCOPE_CLOUD = '1';
process.env.SCOPE_TOKEN = process.env.SCOPE_TOKEN || 'preview-cloud-token-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'scope-preview-cloud-'));
process.env.SCOPE_DIR = join(dir, '.scope');

// Initialize a throwaway workspace so cloud serve has something to manage.
execFileSync(process.execPath, ['bin/scope.js', 'init', '--key', 'DEMO', '--name', 'Demo'], { stdio: 'ignore' });

const mgr = new WorkspaceManager();
mgr.attach(process.env.SCOPE_DIR);
await startServer({ workspaces: mgr, port, cloud: true, tls: false, discoverable: false });
process.stdout.write(`cloud preview (public site) on http://localhost:${port}\n`);
