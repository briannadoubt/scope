import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { randomBytes, X509Certificate } from 'node:crypto';
import { findDeviceBySerial, updateLastSeen } from './devices.js';
import { isRevoked } from './revocation.js';

const CONFIG_DIR = join(homedir(), '.scope-hub');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const COOKIE_NAME = 'scope_token';

export function loadOrCreateToken() {
  // An explicit SCOPE_TOKEN (hosted deploys set this as a secret) is
  // authoritative: stable across restarts and independent of the on-disk config
  // file, whose dir is ephemeral in a container. Without this a cloud hub would
  // mint a fresh random token on every boot, breaking the shared-token login.
  const envTok = process.env.SCOPE_TOKEN;
  if (typeof envTok === 'string' && envTok.length >= 16) return envTok.trim();

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
 * Pull the verified peer cert (if any) from the TLS socket. Returns the
 * `crypto.X509Certificate` instance if the peer presented a cert that node's
 * TLS layer validated against our trust anchors, else null.
 *
 * We require `authorized === true` so we never accept a self-signed cert from
 * an untrusted CA — even though the listener uses `rejectUnauthorized: false`
 * (so browsers without a client cert can still connect), an unauthorized peer
 * cert MUST NOT count as authentication.
 */
function peerCertFromReq(req) {
  const sock = req.socket;
  if (!sock || typeof sock.getPeerCertificate !== 'function') return null;
  if (!sock.authorized) return null;
  const peer = sock.getPeerCertificate(true);
  if (!peer || !peer.raw) return null;
  try {
    return new X509Certificate(peer.raw);
  } catch {
    return null;
  }
}

/** Normalize an X509Certificate.serialNumber (hex string, possibly uppercase
 * with no leading zeros) to the lowercase form devices.js stores. */
function normalizeSerial(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/^0x/, '');
}

/**
 * Look up a device by its presented client cert. Returns the device record on
 * a match (and updates last_seen, debounced), or null. Exposed for tests +
 * the audit log path in server.js.
 */
export function deviceFromPeerCert(cert) {
  if (!cert) return null;
  const serial = normalizeSerial(cert.serialNumber);
  // devices.js stores the serial with whatever case forge emitted (we
  // lowercase on insert). Try both with and without a leading "00" since the
  // certificate's parsed serial drops it.
  const candidates = new Set([serial, '00' + serial]);
  for (const s of candidates) {
    // Hard stop on revoked serials regardless of whether the device is still
    // in devices.json — the revoke command removes it, but a stale entry
    // shouldn't matter either way.
    if (isRevoked(s)) return { _revoked: true };
    const d = findDeviceBySerial(s);
    if (d) {
      updateLastSeen(d.serial_hex);
      return d;
    }
  }
  return null;
}

/**
 * Express middleware enforcing:
 *  1. Host header is one of the known names (DNS rebinding defense).
 *  2. Non-loopback requests authenticate via *either*:
 *     - a valid bearer token (header, query, or cookie) — browser path, or
 *     - a TLS client cert signed by our local CA that maps to a paired
 *       device in devices.json — native path.
 *
 * Loopback requests bypass both checks — same machine, same user, and other
 * scope CLI processes probe /api/meta on localhost during hub discovery.
 *
 * On a successful cert-auth, req.device is set to the device record so
 * downstream handlers (and the future audit log) can attribute the request.
 */
/**
 * @param {object} opts
 * @param {string} opts.token
 * @param {string[]} opts.allowedHosts - host allowlist (empty = allow any, for
 *   hosted mode where the edge proxy already routes by host).
 * @param {boolean} [opts.trustLoopback=true] - bypass auth for loopback peers.
 *   MUST be false in hosted/cloud mode (SCP-161): behind a reverse proxy inside
 *   a container, requests can appear to originate from loopback, so trusting it
 *   would let anyone through unauthenticated.
 */
export function authMiddleware({ token, allowedHosts, trustLoopback = true }) {
  const hostSet = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return (req, res, next) => {
    // mTLS short-circuit: if the peer presented a CA-signed client cert we
    // *always* verify it — even on loopback — because the cert is an
    // explicit identity claim. A revoked cert should be 401 even from
    // 127.0.0.1. (Without a peer cert, loopback bypasses auth so the CLI's
    // hub-discovery probes and same-machine `scope` commands still work.)
    const peer = peerCertFromReq(req);
    if (peer) {
      const device = deviceFromPeerCert(peer);
      if (device?._revoked) {
        return res.status(401).json({ error: 'certificate revoked' });
      }
      if (device) {
        req.device = device;
        return next();
      }
      // Peer cert was signed by our CA (node's TLS validated it against the
      // ca: option) but doesn't correspond to a known device — likely an
      // out-of-band cert. Refuse rather than falling through to the bearer
      // path (a stolen valid cert shouldn't get a second chance).
      return res.status(401).json({ error: 'unknown client certificate' });
    }

    if (trustLoopback && isLoopback(req)) return next();

    const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase();
    if (hostSet.size && hostHeader && !hostSet.has(hostHeader)) {
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
