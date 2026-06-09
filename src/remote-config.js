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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const REMOTE_CONFIG_FILE = 'remote.json';

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
