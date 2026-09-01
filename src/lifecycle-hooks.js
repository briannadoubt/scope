import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ScopeCliError } from './protocol.js';

const PROVIDERS = new Set(['codex', 'claude']);
const MANAGED_COMMAND_PREFIX = 'scope bridge lifecycle --provider ';

function lifecycleHome(env = process.env) {
  return env.HOME || homedir();
}

export function lifecycleHookPath(provider, env = process.env) {
  if (!PROVIDERS.has(provider)) throw new ScopeCliError(`unsupported hook provider: ${provider}`, {
    code: 'BRIDGE_PROVIDER_UNSUPPORTED',
  });
  const home = lifecycleHome(env);
  return provider === 'codex'
    ? join(home, '.codex', 'hooks.json')
    : join(home, '.claude', 'settings.json');
}

function readConfig(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('root must be an object');
    return parsed;
  } catch (error) {
    throw new ScopeCliError(`cannot install lifecycle hooks into invalid JSON at ${path}: ${error.message}`, {
      code: 'BRIDGE_HOOK_CONFIG_INVALID',
    });
  }
}

function writeConfig(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(temp, mode);
  renameSync(temp, path);
}

function isManagedHandler(handler) {
  return handler?.type === 'command'
    && typeof handler.command === 'string'
    && handler.command.startsWith(MANAGED_COMMAND_PREFIX);
}

function removeManagedHandlers(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    if (!group || typeof group !== 'object') return [];
    const handlers = Array.isArray(group.hooks) ? group.hooks.filter((handler) => !isManagedHandler(handler)) : [];
    return handlers.length ? [{ ...group, hooks: handlers }] : [];
  });
}

function managedGroups(provider) {
  const command = `${MANAGED_COMMAND_PREFIX}${provider}`;
  const startMatcher = provider === 'claude' ? 'startup|resume|clear|fork' : 'startup|resume|clear|compact';
  return {
    SessionStart: {
      matcher: startMatcher,
      hooks: [{ type: 'command', command, timeout: 10, statusMessage: 'Connecting Scope session' }],
    },
    SessionEnd: {
      hooks: [{ type: 'command', command, timeout: 3 }],
    },
  };
}

export function lifecycleHookStatus(provider, options = {}) {
  const path = options.path || lifecycleHookPath(provider, options.env);
  const config = readConfig(path);
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  const command = `${MANAGED_COMMAND_PREFIX}${provider}`;
  const installedEvents = ['SessionStart', 'SessionEnd'].filter((event) =>
    Array.isArray(hooks[event])
    && hooks[event].some((group) => Array.isArray(group?.hooks)
      && group.hooks.some((handler) => handler?.type === 'command' && handler.command === command))
  );
  return { provider, path, installed: installedEvents.length === 2, installedEvents };
}

export function installLifecycleHooks(provider, options = {}) {
  if (!PROVIDERS.has(provider)) throw new ScopeCliError(`unsupported hook provider: ${provider}`, {
    code: 'BRIDGE_PROVIDER_UNSUPPORTED',
  });
  const path = options.path || lifecycleHookPath(provider, options.env);
  const config = readConfig(path);
  if (config.hooks !== undefined
    && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) {
    throw new ScopeCliError(`cannot install lifecycle hooks into invalid hooks configuration at ${path}`, {
      code: 'BRIDGE_HOOK_CONFIG_INVALID',
    });
  }
  const hooks = config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? { ...config.hooks }
    : {};
  const managed = managedGroups(provider);
  for (const event of ['SessionStart', 'SessionEnd']) {
    hooks[event] = [...removeManagedHandlers(hooks[event]), managed[event]];
  }
  writeConfig(path, { ...config, hooks });
  return lifecycleHookStatus(provider, { path });
}
