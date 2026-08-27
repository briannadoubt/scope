import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { acknowledgeMessage, listInbox } from './agent-mailbox.js';
import { ScopeCliError } from './protocol.js';
import { openWorkspaceDb } from './workspace-open.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDERS = new Set(['codex', 'claude']);
const DEFAULT_POLL_MS = 1_000;
const RUNNER_STALE_MS = 10_000;
const MAX_PROMPT_CHARS = 2_000;
const MAX_STDERR_CHARS = 8_192;

function bridgeHome(env = process.env) {
  return env.SCOPE_HOME || join(env.HOME || homedir(), '.scope');
}

export function bridgePaths(env = process.env) {
  const root = bridgeHome(env);
  return {
    config: join(root, 'bridge.json'),
    state: join(root, 'bridge-state.json'),
    lock: join(root, 'bridge.lock'),
  };
}

function emptyConfig() {
  return { version: 1, bindings: [] };
}

function emptyState() {
  return { version: 1, runner: null, deliveries: {} };
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback();
  } catch {
    return fallback();
  }
}

function writePrivateJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

function nowIso(now = () => new Date()) {
  return now().toISOString();
}

function bindingKey(scopeDir, agentId) {
  return `${resolve(scopeDir)}\0${agentId}`;
}

function safeSessionRef(sessionId) {
  return `sha256:${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`;
}

export function normalizeSessionProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'openai') return 'codex';
  if (normalized === 'anthropic') return 'claude';
  if (PROVIDERS.has(normalized)) return normalized;
  throw new ScopeCliError(`unsupported session provider: ${provider}`, {
    code: 'BRIDGE_PROVIDER_UNSUPPORTED',
    details: { supportedProviders: [...PROVIDERS] },
  });
}

function assertSessionId(sessionId) {
  const value = String(sessionId || '').trim();
  if (!UUID_RE.test(value)) {
    throw new ScopeCliError('session id must be a UUID', { code: 'BRIDGE_SESSION_INVALID' });
  }
  return value;
}

function assertAgentId(agentId) {
  const value = String(agentId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,127}$/.test(value)) {
    throw new ScopeCliError('invalid agent id', { code: 'BRIDGE_AGENT_INVALID' });
  }
  return value;
}

export function currentSessionId(provider, env = process.env) {
  const normalized = normalizeSessionProvider(provider);
  const value = normalized === 'codex'
    ? env.CODEX_THREAD_ID || env.CODEX_SESSION_ID
    : env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID;
  return value && UUID_RE.test(value) ? value : null;
}

export function readBridgeConfig(options = {}) {
  const path = options.path || bridgePaths(options.env).config;
  const value = readJson(path, emptyConfig);
  return {
    version: 1,
    bindings: Array.isArray(value.bindings) ? value.bindings.filter((binding) => {
      if (!binding || typeof binding !== 'object') return false;
      if (typeof binding.scopeDir !== 'string' || !binding.scopeDir) return false;
      if (typeof binding.cwd !== 'string' || !binding.cwd) return false;
      if (!PROVIDERS.has(binding.provider) || !UUID_RE.test(binding.sessionId || '')) return false;
      return /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,127}$/.test(binding.agentId || '');
    }) : [],
  };
}

export function readBridgeState(options = {}) {
  const path = options.path || bridgePaths(options.env).state;
  const value = readJson(path, emptyState);
  return {
    version: 1,
    runner: value.runner && typeof value.runner === 'object' ? value.runner : null,
    deliveries: value.deliveries && typeof value.deliveries === 'object' ? value.deliveries : {},
  };
}

function publicBinding(binding) {
  return {
    agentId: binding.agentId,
    provider: binding.provider,
    sessionRef: safeSessionRef(binding.sessionId),
    boundAt: binding.boundAt,
    updatedAt: binding.updatedAt,
  };
}

export function bindSession({ scopeDir, agentId, provider, sessionId, cwd, env, now = () => new Date() }) {
  const paths = bridgePaths(env);
  const normalizedScopeDir = resolve(scopeDir);
  const normalizedAgentId = assertAgentId(agentId);
  const normalizedProvider = normalizeSessionProvider(provider);
  const normalizedSessionId = assertSessionId(sessionId || currentSessionId(normalizedProvider, env));
  const config = readBridgeConfig({ path: paths.config });
  const key = bindingKey(normalizedScopeDir, normalizedAgentId);
  const existing = config.bindings.find((item) => bindingKey(item.scopeDir, item.agentId) === key);
  const timestamp = nowIso(now);
  const binding = {
    scopeDir: normalizedScopeDir,
    agentId: normalizedAgentId,
    provider: normalizedProvider,
    sessionId: normalizedSessionId,
    cwd: resolve(cwd || dirname(normalizedScopeDir)),
    boundAt: existing?.boundAt || timestamp,
    updatedAt: timestamp,
  };
  config.bindings = config.bindings.filter((item) => bindingKey(item.scopeDir, item.agentId) !== key);
  config.bindings.push(binding);
  writePrivateJson(paths.config, config);
  return publicBinding(binding);
}

export function unbindSession({ scopeDir, agentId, env }) {
  const paths = bridgePaths(env);
  const normalizedScopeDir = resolve(scopeDir);
  const normalizedAgentId = assertAgentId(agentId);
  const config = readBridgeConfig({ path: paths.config });
  const key = bindingKey(normalizedScopeDir, normalizedAgentId);
  const before = config.bindings.length;
  config.bindings = config.bindings.filter((item) => bindingKey(item.scopeDir, item.agentId) !== key);
  if (config.bindings.length !== before) writePrivateJson(paths.config, config);
  return { agentId: normalizedAgentId, removed: config.bindings.length !== before };
}

export function listSessionBindings({ scopeDir, env } = {}) {
  const normalizedScopeDir = scopeDir ? resolve(scopeDir) : null;
  return readBridgeConfig({ env }).bindings
    .filter((binding) => !normalizedScopeDir || resolve(binding.scopeDir) === normalizedScopeDir)
    .map(publicBinding);
}

function deliveryKey(scopeDir, messageId) {
  return createHash('sha256').update(`${resolve(scopeDir)}\0${messageId}`).digest('hex');
}

function retryDelayMs(attempts) {
  return Math.min(30_000 * (2 ** Math.max(0, attempts - 1)), 15 * 60_000);
}

function classifyProviderFailure(error, stderr = '') {
  if (error?.code === 'ENOENT') return 'BRIDGE_PROVIDER_MISSING';
  if (error?.code === 'ETIMEDOUT') return 'BRIDGE_PROVIDER_TIMEOUT';
  if (/session|thread|conversation/i.test(stderr) && /not found|unknown|invalid/i.test(stderr)) {
    return 'BRIDGE_SESSION_NOT_FOUND';
  }
  if (/busy|locked|already running|in use/i.test(stderr)) return 'BRIDGE_SESSION_BUSY';
  return 'BRIDGE_PROVIDER_FAILED';
}

export function bridgePrompt(binding, message) {
  const text = [
    `Scope has a pending durable message ${message.messageId} addressed to ${binding.agentId}.`,
    `Run \`scope --json message show ${message.messageId}\` in the current Scope workspace, inspect any linked ticket/context, and process the message exactly once.`,
    'Reply in the Scope thread when useful. Do not acknowledge the message yourself; the local session bridge acknowledges it after this turn is accepted.',
  ].join(' ');
  return text.slice(0, MAX_PROMPT_CHARS);
}

export function injectSessionMessage(binding, message, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs || 10 * 60_000;
  const prompt = bridgePrompt(binding, message);
  const args = binding.provider === 'codex'
    ? ['exec', 'resume', '--json', binding.sessionId, '-']
    : ['-p', '--resume', binding.sessionId, '--output-format', 'json'];
  const command = binding.provider === 'codex' ? 'codex' : 'claude';
  const started = Date.now();

  return new Promise((resolveResult) => {
    let settled = false;
    let stderr = '';
    let child;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveResult({ provider: binding.provider, durationMs: Date.now() - started, ...result });
    };
    try {
      child = spawnImpl(command, args, {
        cwd: binding.cwd,
        env: {
          ...process.env,
          ...(options.env || {}),
          SCOPE_DIR: binding.scopeDir,
          SCOPE_BRIDGE_AGENT_ID: binding.agentId,
          SCOPE_BRIDGE_MESSAGE_ID: message.messageId,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (error) {
      resolveResult({
        ok: false,
        provider: binding.provider,
        errorCode: classifyProviderFailure(error),
        durationMs: Date.now() - started,
      });
      return;
    }
    timer = setTimeout(() => {
      const error = new Error('provider timed out');
      error.code = 'ETIMEDOUT';
      child.kill('SIGTERM');
      finish({ ok: false, errorCode: classifyProviderFailure(error) });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.resume();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.slice(0, MAX_STDERR_CHARS - stderr.length);
    });
    child.on('error', (error) => finish({ ok: false, errorCode: classifyProviderFailure(error, stderr) }));
    child.on('close', (code, signal) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, errorCode: classifyProviderFailure({ code, signal }, stderr) });
    });
    child.stdin?.end(prompt);
  });
}

function setDeliveryState(paths, scopeDir, messageId, patch, now) {
  const state = readBridgeState({ path: paths.state });
  const key = deliveryKey(scopeDir, messageId);
  state.deliveries[key] = {
    ...(state.deliveries[key] || {}),
    messageId,
    ...patch,
    updatedAt: nowIso(now),
  };
  writePrivateJson(paths.state, state);
  return state.deliveries[key];
}

function heartbeatRunner(paths, now) {
  const state = readBridgeState({ path: paths.state });
  state.runner = { pid: process.pid, heartbeatAt: nowIso(now) };
  writePrivateJson(paths.state, state);
}

function acquireRunnerLock(paths, now) {
  mkdirSync(dirname(paths.lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(paths.lock, 'wx', 0o600);
      try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
      chmodSync(paths.lock, 0o600);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let lockPid;
      try {
        lockPid = Number.parseInt(readFileSync(paths.lock, 'utf8'), 10);
      } catch (readError) {
        if (readError?.code === 'ENOENT') continue;
        throw readError;
      }
      const state = readBridgeState({ path: paths.state });
      const heartbeatAt = Date.parse(state.runner?.heartbeatAt || '');
      const active = state.runner?.pid === lockPid
        && Number.isFinite(heartbeatAt)
        && now().getTime() - heartbeatAt <= RUNNER_STALE_MS;
      if (active) return false;
      try { unlinkSync(paths.lock); } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  return false;
}

function releaseRunnerLock(paths) {
  try {
    const lockPid = Number.parseInt(readFileSync(paths.lock, 'utf8'), 10);
    if (lockPid === process.pid) unlinkSync(paths.lock);
  } catch {
    // Shutdown and stale-lock cleanup are best effort. Delivery state remains
    // recoverable even if a filesystem race removes the lock first.
  }
}

export function sessionBridgeOverview(scopeDir, options = {}) {
  const normalizedScopeDir = resolve(scopeDir);
  const config = readBridgeConfig(options);
  const state = readBridgeState(options);
  const heartbeatAt = state.runner?.heartbeatAt ? Date.parse(state.runner.heartbeatAt) : 0;
  const currentTime = options.now ? options.now().getTime() : Date.now();
  const connected = currentTime - heartbeatAt <= RUNNER_STALE_MS;
  const deliveries = Object.values(state.deliveries);
  const result = {};
  for (const binding of config.bindings.filter((item) => resolve(item.scopeDir) === normalizedScopeDir)) {
    const relevant = deliveries
      .filter((item) => item.agentId === binding.agentId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const latest = relevant[0] || null;
    result[binding.agentId] = {
      bound: true,
      connected,
      provider: binding.provider,
      sessionRef: safeSessionRef(binding.sessionId),
      lastDeliveryAt: latest?.updatedAt || null,
      lastErrorCode: latest?.errorCode || null,
      retrying: relevant.some((item) => item.status === 'retrying'),
    };
  }
  return result;
}

export class SessionBridgeRunner {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.paths = bridgePaths(this.env);
    this.pollMs = options.pollMs || DEFAULT_POLL_MS;
    this.now = options.now || (() => new Date());
    this.inject = options.inject || injectSessionMessage;
    this.openWorkspace = options.openWorkspace || openWorkspaceDb;
    this.timer = null;
    this.running = false;
    this.ownsLock = false;
    this.exitHandler = null;
    this.inFlight = new Set();
    this.dbs = new Map();
  }

  start() {
    if (this.timer) return this;
    this.activate();
    this.timer = setInterval(() => {
      if (!this.ownsLock) this.activate();
      if (this.ownsLock) void this.tick();
    }, this.pollMs);
    this.timer.unref?.();
    if (this.ownsLock) void this.tick();
    return this;
  }

  activate() {
    if (this.ownsLock) return true;
    this.ownsLock = acquireRunnerLock(this.paths, this.now);
    if (!this.ownsLock) return false;
    this.exitHandler = () => releaseRunnerLock(this.paths);
    process.once('exit', this.exitHandler);
    heartbeatRunner(this.paths, this.now);
    return true;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.exitHandler) process.removeListener('exit', this.exitHandler);
    this.exitHandler = null;
    for (const db of this.dbs.values()) {
      try { db.close(); } catch {}
    }
    this.dbs.clear();
    if (this.ownsLock) releaseRunnerLock(this.paths);
    this.ownsLock = false;
  }

  workspaceDb(scopeDir) {
    const key = resolve(scopeDir);
    if (!this.dbs.has(key)) this.dbs.set(key, this.openWorkspace(key).db);
    return this.dbs.get(key);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      heartbeatRunner(this.paths, this.now);
      const bindings = readBridgeConfig({ path: this.paths.config }).bindings;
      await Promise.all(bindings.map((binding) => this.processBinding(binding)));
    } finally {
      this.running = false;
    }
  }

  async processBinding(binding) {
    const key = bindingKey(binding.scopeDir, binding.agentId);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const db = this.workspaceDb(binding.scopeDir);
      const message = listInbox(db, binding.agentId, { status: 'pending', limit: 1 })[0];
      if (!message) return;
      const state = readBridgeState({ path: this.paths.state });
      const id = deliveryKey(binding.scopeDir, message.messageId);
      const previous = state.deliveries[id];

      if (previous?.status === 'accepted') {
        acknowledgeMessage(db, message.messageId, { agent: binding.agentId, actor: 'scope:session-bridge' });
        setDeliveryState(this.paths, binding.scopeDir, message.messageId, {
          agentId: binding.agentId, provider: binding.provider, status: 'acknowledged', errorCode: null,
        }, this.now);
        return;
      }
      if (previous?.nextAttemptAt && Date.parse(previous.nextAttemptAt) > this.now().getTime()) return;

      const attempts = Number(previous?.attempts || 0) + 1;
      setDeliveryState(this.paths, binding.scopeDir, message.messageId, {
        agentId: binding.agentId, provider: binding.provider, status: 'injecting', attempts,
        errorCode: null, nextAttemptAt: null,
      }, this.now);
      const result = await this.inject(binding, message, { env: this.env });
      if (!result.ok) {
        setDeliveryState(this.paths, binding.scopeDir, message.messageId, {
          agentId: binding.agentId,
          provider: binding.provider,
          status: 'retrying',
          attempts,
          errorCode: result.errorCode || 'BRIDGE_PROVIDER_FAILED',
          durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
          nextAttemptAt: new Date(this.now().getTime() + retryDelayMs(attempts)).toISOString(),
        }, this.now);
        return;
      }

      // Persist acceptance before mutating Scope. If this process exits between
      // these writes, the next runner acknowledges without injecting twice.
      setDeliveryState(this.paths, binding.scopeDir, message.messageId, {
        agentId: binding.agentId, provider: binding.provider, status: 'accepted', attempts,
        errorCode: null, nextAttemptAt: null,
        durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
      }, this.now);
      acknowledgeMessage(db, message.messageId, { agent: binding.agentId, actor: 'scope:session-bridge' });
      setDeliveryState(this.paths, binding.scopeDir, message.messageId, {
        agentId: binding.agentId, provider: binding.provider, status: 'acknowledged', attempts,
        errorCode: null, nextAttemptAt: null,
      }, this.now);
    } catch (error) {
      // A broken workspace or malformed private binding must not stop delivery
      // to unrelated sessions. The next poll retries after the issue is fixed.
    } finally {
      this.inFlight.delete(key);
    }
  }
}

export function startSessionBridge(options = {}) {
  return new SessionBridgeRunner(options).start();
}
