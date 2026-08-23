import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { readAllEvents, eventsDir } from './event-store.js';
import { workspaceDataDir } from './workspace-storage.js';

export const PROTOCOL_VERSION = '1.0';

export class ScopeCliError extends Error {
  constructor(message, { code = 'INVALID_ARGUMENT', retryable = false, details = null, exitCode = 1 } = {}) {
    super(message);
    this.name = 'ScopeCliError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export class ReceiptReplay extends Error {
  constructor(envelope) {
    super('request already completed');
    this.name = 'ReceiptReplay';
    this.envelope = envelope;
  }
}

export function successEnvelope(data, meta = {}) {
  return { ok: true, protocolVersion: PROTOCOL_VERSION, data, meta };
}

export function errorEnvelope(error, meta = {}) {
  const normalized = normalizeError(error);
  return {
    ok: false,
    protocolVersion: PROTOCOL_VERSION,
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.details == null ? {} : { details: normalized.details }),
    },
    meta,
  };
}

export function normalizeError(error) {
  if (error instanceof ScopeCliError) return error;
  const message = error?.message || String(error);
  if (error?.code === 'UNSUPPORTED_EVENT_FORMAT') {
    return new ScopeCliError(message, {
      code: 'UNSUPPORTED_EVENT_FORMAT',
      details: {
        version: error.version,
        supportedVersions: error.supportedVersions,
        writerVersion: error.writerVersion,
      },
    });
  }
  if (/not found|No \.scope/i.test(message))
    return new ScopeCliError(message, { code: 'NOT_FOUND' });
  if (/stale|revision/i.test(message))
    return new ScopeCliError(message, { code: 'STALE_REVISION', retryable: true });
  if (/locked|busy|temporar|timeout/i.test(message))
    return new ScopeCliError(message, { code: 'TEMPORARY_UNAVAILABLE', retryable: true });
  return new ScopeCliError(message, { code: 'INTERNAL' });
}

/** A deterministic revision for the exact committed event set. */
export function revisionForEvents(events) {
  const ids = events.map((event) => event.id).sort();
  return `sha256:${createHash('sha256').update(ids.join('\n')).digest('hex')}`;
}

export function workspaceRevision(scopeDir) {
  return revisionForEvents(readAllEvents(eventsDir(scopeDir)));
}

function receiptPath(scopeDir, requestId) {
  const name = createHash('sha256').update(String(requestId)).digest('hex');
  return join(workspaceDataDir(scopeDir), 'receipts', `${name}.json`);
}

export function readReceipt(scopeDir, requestId) {
  if (!scopeDir || !requestId) return null;
  const path = receiptPath(scopeDir, requestId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeReceipt(scopeDir, requestId, command, envelope) {
  if (!scopeDir || !requestId) return null;
  const path = receiptPath(scopeDir, requestId);
  mkdirSync(join(workspaceDataDir(scopeDir), 'receipts'), { recursive: true });
  const receipt = { requestId, command, createdAt: new Date().toISOString(), envelope };
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, 'utf8'));
    if (existing.command !== command) {
      throw new ScopeCliError(`request id ${requestId} was already used for ${existing.command}`, {
        code: 'REQUEST_ID_REUSED',
        details: { originalCommand: existing.command, attemptedCommand: command },
      });
    }
    return existing;
  }
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(receipt, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return receipt;
}
