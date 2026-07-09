/**
 * Remote config (SCP-193) — `.scope/remote.json`, the committed, team-shared
 * pointer at a hosted hub: which base URL to sync with and which project
 * (tenant) board to target. `.scope/` is committed to git (the event log lives
 * there), so this file ships with the repo and is shared by the whole team.
 *
 * NO SECRETS, EVER: credentials never go in this file. Tokens come from
 * --token / $SCOPE_API_KEY / $SCOPE_TOKEN at invocation time, and
 * writeRemoteConfig enforces the rule by persisting only `url` and `project`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const REMOTE_CONFIG_FILE = 'remote.json';
export const DEFAULT_CLOUD_URL = 'https://scope-hub.fly.dev';

// Credentials live OUTSIDE the repo (machine-local, per-user), keyed by hub URL —
// NEVER in .scope/remote.json, which is committed (SCP-232/236). Same dir the
// shared-token config uses (auth.js).
const CRED_DIR = join(homedir(), '.scope-hub');
const CRED_FILE = join(CRED_DIR, 'credentials.json');

function readCreds() {
  if (!existsSync(CRED_FILE)) return {};
  try { return JSON.parse(readFileSync(CRED_FILE, 'utf8')); } catch { return {}; }
}

/** The stored API key for a hub URL, falling back to $SCOPE_API_KEY/$SCOPE_TOKEN. */
export function readCredential(url) {
  const stored = url ? readCreds()[url.replace(/\/$/, '')]?.key : null;
  return stored || process.env.SCOPE_API_KEY || process.env.SCOPE_TOKEN || null;
}

/** Persist an API key for a hub URL (machine-local, 0600). */
export function writeCredential(url, key) {
  if (!url || !key) return;
  if (!existsSync(CRED_DIR)) mkdirSync(CRED_DIR, { recursive: true });
  const creds = readCreds();
  creds[url.replace(/\/$/, '')] = { key };
  writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2) + '\n');
  try { chmodSync(CRED_FILE, 0o600); } catch { /* best effort */ }
}

/** Forget a hub URL's stored key. */
export function clearCredential(url) {
  if (!url) return;
  const creds = readCreds();
  delete creds[url.replace(/\/$/, '')];
  if (existsSync(CRED_DIR)) writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2) + '\n');
}

/** Remove .scope/remote.json (disconnect). Idempotent. */
export function clearRemoteConfig(scopeDir) {
  if (!scopeDir) return;
  const path = remoteConfigPath(scopeDir);
  if (existsSync(path)) rmSync(path);
}

/**
 * Legacy helper: add `events/` to .scope/.gitignore. New quiet workspaces use
 * explicit storage metadata via `scope events move-to-local`; this remains as a
 * compatibility fallback for older connect flows.
 */
export function ignoreEventLog(scopeDir) {
  if (!scopeDir) return false;
  const gi = join(scopeDir, '.gitignore');
  let cur = '';
  try { cur = readFileSync(gi, 'utf8'); } catch { /* no .gitignore yet */ }
  if (/^\s*events\/?\s*$/m.test(cur)) return false;
  const sep = cur && !cur.endsWith('\n') ? '\n' : '';
  writeFileSync(gi, `${cur}${sep}# Board lives on the hub (scope remote) — event log not committed here.\nevents/\n`);
  return true;
}

/** Absolute path of the config file inside a .scope dir. */
export function remoteConfigPath(scopeDir) {
  return join(scopeDir, REMOTE_CONFIG_FILE);
}

/**
 * Read `.scope/remote.json`. Returns the parsed object, or null when the file
 * doesn't exist (or no scopeDir was given). A malformed file throws with the
 * path in the message so the user can fix or delete it.
 *
 * @param {string|null} scopeDir
 * @returns {{url?: string, project?: string}|null}
 */
export function readRemoteConfig(scopeDir) {
  if (!scopeDir) return null;
  const path = remoteConfigPath(scopeDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse ${path}: ${e.message}`);
  }
}

/**
 * Write `.scope/remote.json` pretty-printed:
 *
 *   {
 *     "url": "https://scope-hub.fly.dev",
 *     "project": "tnt_…"
 *   }
 *
 * Persists ONLY `url` and `project` — anything else (especially anything
 * credential-shaped) is dropped, because this file is committed and shared.
 *
 * @param {string} scopeDir
 * @param {{url?: string, project?: string}} cfg
 * @returns {{url?: string, project?: string}} what was written
 */
export function writeRemoteConfig(scopeDir, { url, project } = {}) {
  const cfg = {};
  if (url) cfg.url = url;
  if (project) cfg.project = project;
  writeFileSync(remoteConfigPath(scopeDir), JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

/**
 * Resolve the effective remote target, merging precedence (highest wins):
 *
 *   1. explicit flags     opts.remote / opts.project
 *   2. environment        $SCOPE_REMOTE / $SCOPE_PROJECT
 *   3. committed config   .scope/remote.json
 *   4. nothing            null
 *
 * @param {string|null} scopeDir - the .scope dir (null skips the file layer)
 * @param {{remote?: string, project?: string}} [opts] - explicit flag values
 * @returns {{url: string|null, project: string|null,
 *            source: {url: 'flag'|'env'|'file'|'none',
 *                     project: 'flag'|'env'|'file'|'none'}}}
 *   each value tagged with where it came from, so commands can explain
 *   themselves (`scope remote show`).
 */
export function resolveRemote(scopeDir, opts = {}) {
  const file = readRemoteConfig(scopeDir);
  const pick = (flag, env, fromFile) => {
    if (flag) return [flag, 'flag'];
    if (env) return [env, 'env'];
    if (fromFile) return [fromFile, 'file'];
    return [null, 'none'];
  };
  const [url, urlSource] = pick(opts.remote, process.env.SCOPE_REMOTE, file?.url);
  const [project, projectSource] = pick(opts.project, process.env.SCOPE_PROJECT, file?.project);
  return { url, project, source: { url: urlSource, project: projectSource } };
}
