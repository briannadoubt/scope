import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const WORKSPACE_CONFIG_FILE = 'workspace.json';
export const WORKSPACE_DB_FILE_NAME = 'scope.db';
export const STORAGE_MODES = new Set(['local', 'git']);

export function workspaceConfigPath(scopeDir) {
  return join(scopeDir, WORKSPACE_CONFIG_FILE);
}

function normalizeMode(mode) {
  const m = mode || 'local';
  if (!STORAGE_MODES.has(m)) throw new Error(`Unsupported Scope storage mode: ${m}`);
  return m;
}

function stableId(scopeDir) {
  const hash = createHash('sha256').update(resolve(scopeDir)).digest('hex').slice(0, 20);
  return `ws_${hash}`;
}

export function readWorkspaceStorageConfig(scopeDir) {
  if (!scopeDir) return null;
  const path = workspaceConfigPath(scopeDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Could not parse ${path}: ${e.message}`);
  }
}

export function writeWorkspaceStorageConfig(scopeDir, cfg) {
  if (!existsSync(scopeDir)) mkdirSync(scopeDir, { recursive: true });
  const out = {
    version: 1,
    id: cfg.id || stableId(scopeDir),
    storage: { mode: normalizeMode(cfg.storage?.mode || cfg.mode) },
  };
  writeFileSync(workspaceConfigPath(scopeDir), JSON.stringify(out, null, 2) + '\n');
  return out;
}

export function ensureWorkspaceStorageConfig(scopeDir, { mode = 'local' } = {}) {
  const existing = readWorkspaceStorageConfig(scopeDir);
  if (existing) return existing;
  return writeWorkspaceStorageConfig(scopeDir, {
    id: `ws_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    storage: { mode },
  });
}

export function storageMode(scopeDir) {
  return readWorkspaceStorageConfig(scopeDir)?.storage?.mode || 'git';
}

export function localWorkspaceDataDir(scopeDir, cfg = readWorkspaceStorageConfig(scopeDir)) {
  const id = cfg?.id || stableId(scopeDir);
  return join(homedir(), '.scope', 'workspaces', id);
}

export function workspaceDataDir(scopeDir) {
  const cfg = readWorkspaceStorageConfig(scopeDir);
  if (cfg?.storage?.mode === 'local') return localWorkspaceDataDir(scopeDir, cfg);
  return scopeDir;
}

export function workspaceDbPath(scopeDir) {
  return join(workspaceDataDir(scopeDir), WORKSPACE_DB_FILE_NAME);
}

export function workspaceEventsDir(scopeDir) {
  return join(workspaceDataDir(scopeDir), 'events');
}

export function localBackupDir(scopeDir, cfg = readWorkspaceStorageConfig(scopeDir)) {
  return join(localWorkspaceDataDir(scopeDir, cfg), 'backups');
}

function eventFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('.')).sort();
}

function copyEvents(source, target) {
  mkdirSync(target, { recursive: true });
  if (!existsSync(source)) return 0;
  cpSync(source, target, { recursive: true, force: true });
  return eventFiles(target).length;
}

function sameNames(a, b) {
  if (a.length !== b.length) return false;
  return a.every((name, idx) => name === b[idx]);
}

function ensureCompatibleTarget(source, target) {
  const sourceFiles = eventFiles(source);
  const targetFiles = eventFiles(target);
  if (targetFiles.length && !sameNames(sourceFiles, targetFiles)) {
    throw new Error(
      `local event store already has different events: ${target}. ` +
      'Run `scope events status` and move or back up that store before migrating.'
    );
  }
  return { sourceFiles, targetFiles };
}

function copyDbFiles(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = join(sourceDir, `${WORKSPACE_DB_FILE_NAME}${suffix}`);
    if (existsSync(source)) cpSync(source, join(targetDir, `${WORKSPACE_DB_FILE_NAME}${suffix}`), { force: true });
  }
}

export function updateScopeGitignore(scopeDir, mode) {
  const path = join(scopeDir, '.gitignore');
  let lines = [];
  try { lines = readFileSync(path, 'utf8').split(/\r?\n/); } catch {}
  const wanted = ['scope.db', 'scope.db-wal', 'scope.db-shm'];
  lines = lines.filter((line) => {
    if (mode === 'git' && /^\s*events\/?\s*$/.test(line)) return false;
    return true;
  });
  if (mode === 'local' && !lines.some((line) => /^\s*events\/?\s*$/.test(line))) {
    lines.push('# Scope: quiet local storage keeps event files out of git.');
    lines.push('events/');
  }
  for (const rule of wanted) {
    const re = new RegExp(`^\\s*${rule.replace('.', '\\.')}\\s*$`);
    if (!lines.some((line) => re.test(line))) lines.push(rule);
  }
  const out = lines.filter((line, idx, arr) => line !== '' || idx < arr.length - 1).join('\n') + '\n';
  writeFileSync(path, out);
}

export function migrateEventsToLocal(scopeDir, { dryRun = false } = {}) {
  const source = join(scopeDir, 'events');
  const before = readWorkspaceStorageConfig(scopeDir);
  const cfg = before || {
    version: 1,
    id: stableId(scopeDir),
    storage: { mode: 'git' },
  };
  const targetCfg = { ...cfg, storage: { mode: 'local' } };
  const target = join(localWorkspaceDataDir(scopeDir, targetCfg), 'events');
  const backup = join(localBackupDir(scopeDir, targetCfg), `repo-events-${Date.now()}`);
  const { sourceFiles, targetFiles } = ensureCompatibleTarget(source, target);
  const sourceCount = sourceFiles.length;
  const targetCount = targetFiles.length;
  const result = {
    mode: 'local',
    source,
    target,
    backup,
    copied: sourceCount,
    existing: targetCount,
    dryRun: !!dryRun,
  };
  if (dryRun) return result;

  if (sourceCount) {
    const staging = join(localWorkspaceDataDir(scopeDir, targetCfg), `events.migrating-${Date.now()}`);
    rmSync(staging, { recursive: true, force: true });
    copyEvents(source, staging);
    mkdirSync(dirname(backup), { recursive: true });
    cpSync(source, backup, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    copyDbFiles(scopeDir, localWorkspaceDataDir(scopeDir, targetCfg));
    writeWorkspaceStorageConfig(scopeDir, targetCfg);
    rmSync(source, { recursive: true, force: true });
  } else {
    writeWorkspaceStorageConfig(scopeDir, targetCfg);
  }
  updateScopeGitignore(scopeDir, 'local');
  return result;
}

export function migrateEventsToGit(scopeDir, { dryRun = false } = {}) {
  const cfg = readWorkspaceStorageConfig(scopeDir) || {
    version: 1,
    id: stableId(scopeDir),
    storage: { mode: 'local' },
  };
  const source = join(localWorkspaceDataDir(scopeDir, cfg), 'events');
  const target = join(scopeDir, 'events');
  const sourceCount = eventFiles(source).length;
  const result = {
    mode: 'git',
    source,
    target,
    copied: sourceCount,
    dryRun: !!dryRun,
  };
  if (dryRun) return result;

  if (sourceCount) copyEvents(source, target);
  copyDbFiles(localWorkspaceDataDir(scopeDir, cfg), scopeDir);
  writeWorkspaceStorageConfig(scopeDir, { ...cfg, storage: { mode: 'git' } });
  updateScopeGitignore(scopeDir, 'git');
  return result;
}

export function storageStatus(scopeDir) {
  const cfg = readWorkspaceStorageConfig(scopeDir);
  const mode = cfg?.storage?.mode || 'git';
  const dataDir = workspaceDataDir(scopeDir);
  const eventDir = workspaceEventsDir(scopeDir);
  return {
    mode,
    scopeDir,
    marker: workspaceConfigPath(scopeDir),
    dataDir,
    db: join(dataDir, WORKSPACE_DB_FILE_NAME),
    events: eventDir,
    eventCount: eventFiles(eventDir).length,
    repoEventsPresent: existsSync(join(scopeDir, 'events')),
  };
}
