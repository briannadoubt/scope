import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DOGFOOD_LOG_ENV = 'SCOPE_DOGFOOD_LOG';
export const DOGFOOD_SCHEMA_VERSION = 1;

const SAFE_OPERATION = /^[A-Za-z0-9_ ./:-]{1,200}$/;
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,80}$/;

export function dogfoodConfigPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, '.scope', 'dogfood.json');
}

export function readDogfoodConfig(env = process.env) {
  const path = dogfoodConfigPath(env);
  if (!existsSync(path)) return null;
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    if (!config || typeof config !== 'object') return null;
    return config;
  } catch {
    return null;
  }
}

export function dogfoodStatus(env = process.env) {
  if (env[DOGFOOD_LOG_ENV]) {
    return { enabled: true, source: 'environment', logPath: resolve(env[DOGFOOD_LOG_ENV]) };
  }
  const config = readDogfoodConfig(env);
  if (config?.enabled === false) {
    return {
      enabled: false,
      source: 'config',
      logPath: typeof config.logPath === 'string' ? resolve(config.logPath) : null,
    };
  }
  const configuredPath = typeof config?.logPath === 'string' && config.logPath.length > 0
    ? config.logPath
    : join(dirname(dogfoodConfigPath(env)), 'dogfood', 'usage.ndjson');
  return {
    enabled: true,
    source: config ? 'config' : 'default',
    logPath: resolve(configuredPath),
  };
}

function writeDogfoodConfig(config, env = process.env) {
  const path = dogfoodConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  return config;
}

export function enableDogfoodTelemetry(logPath, { env = process.env, now = () => new Date() } = {}) {
  const path = resolve(logPath || join(dirname(dogfoodConfigPath(env)), 'dogfood', 'usage.ndjson'));
  writeDogfoodConfig({ enabled: true, logPath: path, updatedAt: now().toISOString() }, env);
  return dogfoodStatus(env);
}

export function disableDogfoodTelemetry({ env = process.env, now = () => new Date() } = {}) {
  const current = readDogfoodConfig(env);
  writeDogfoodConfig({
    enabled: false,
    logPath: typeof current?.logPath === 'string' ? current.logPath : null,
    updatedAt: now().toISOString(),
  }, env);
  return dogfoodStatus(env);
}

/** Stable pseudonym for correlation without writing a raw workspace path/id. */
export function dogfoodWorkspaceHash(value) {
  if (!value) return null;
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/**
 * Append one privacy-bounded local dogfood record. Dogfood builds log to the
 * machine-local default unless explicitly disabled. This function deliberately accepts only the
 * fixed operational fields below: no args, request/response bodies, titles,
 * message text, headers, credentials, or raw filesystem paths can pass through.
 * Telemetry failure must never change Scope command/server behavior.
 */
export function recordDogfoodTelemetry(entry, { env = process.env, now = () => new Date() } = {}) {
  const status = dogfoodStatus(env);
  if (!status.enabled || !status.logPath) return false;

  const surface = entry?.surface === 'http' ? 'http' : entry?.surface === 'cli' ? 'cli' : null;
  const operation = SAFE_OPERATION.test(entry?.operation ?? '') ? entry.operation : null;
  if (!surface || !operation) return false;

  const record = {
    schemaVersion: DOGFOOD_SCHEMA_VERSION,
    timestamp: now().toISOString(),
    surface,
    operation,
    outcome: entry.outcome === 'error' ? 'error' : 'success',
    durationMs: Math.max(0, Math.round(Number(entry.durationMs) || 0)),
  };
  if (Number.isInteger(entry.statusCode)) record.statusCode = entry.statusCode;
  if (SAFE_ERROR_CODE.test(entry.errorCode ?? '')) record.errorCode = entry.errorCode;
  if (entry.workspace) record.workspaceHash = dogfoodWorkspaceHash(entry.workspace);
  if (typeof entry.cliVersion === 'string') record.cliVersion = entry.cliVersion.slice(0, 40);
  if (typeof entry.protocolVersion === 'string') record.protocolVersion = entry.protocolVersion.slice(0, 20);
  if (Number.isInteger(entry.eventFormatVersion)) record.eventFormatVersion = entry.eventFormatVersion;
  for (const flag of ['json', 'requestId', 'ifRevision', 'model', 'replayed']) {
    if (typeof entry[flag] === 'boolean') record[flag] = entry[flag];
  }

  try {
    const path = status.logPath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function startDogfoodSpan(base, options) {
  const startedAt = process.hrtime.bigint();
  let finished = false;
  return {
    finish(result = {}) {
      if (finished) return false;
      finished = true;
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      return recordDogfoodTelemetry({ ...base, ...result, durationMs }, options);
    },
  };
}
