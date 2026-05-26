import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

const CONFIG_DIR = join(homedir(), '.scope-hub');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const COOKIE_NAME = 'scope_token';

export function loadOrCreateToken() {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  if (existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      if (typeof cfg.token === 'string' && cfg.token.length >= 32) return cfg.token;
    } catch {}
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(CONFIG_FILE, JSON.stringify({ token }, null, 2));
  try { chmodSync(CONFIG_FILE, 0o600); } catch {}
  return token;
}

function isLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return parseCookie(req.headers.cookie, COOKIE_NAME);
}

function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Express middleware enforcing:
 *  1. Host header is one of the known names (DNS rebinding defense).
 *  2. Non-loopback requests carry a valid token (header, query, or cookie).
 *
 * Loopback requests bypass both checks — same machine, same user, and other
 * scope CLI processes probe /api/meta on localhost during hub discovery.
 */
export function authMiddleware({ token, allowedHosts }) {
  const hostSet = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return (req, res, next) => {
    if (isLoopback(req)) return next();

    const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase();
    if (hostHeader && !hostSet.has(hostHeader)) {
      return res.status(403).json({ error: 'forbidden host', host: hostHeader });
    }

    const provided = extractToken(req);
    if (!provided || !timingSafeEq(provided, token)) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    // If the token arrived in the URL, set a cookie so the browser stops
    // leaking it via Referer / history on subsequent requests.
    if (typeof req.query?.token === 'string' && req.query.token === token) {
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
      );
    }
    next();
  };
}

export function lanHosts() {
  const out = ['scope.local', 'localhost', '127.0.0.1'];
  const ifs = networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const i of list || []) {
      if (!i.internal) out.push(i.address);
    }
  }
  return out;
}
