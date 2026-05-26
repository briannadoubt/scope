/**
 * Pairing flow — generate short codes on the hub, validate them when a new
 * device POSTs a CSR.
 *
 * The hub keeps codes in memory only (PendingCodes): single-use, 5-minute
 * TTL, constant-time comparison. There's also a simple per-IP rate limiter so
 * an attacker on the LAN can't brute-force the 6-digit code space (1M
 * possibilities, but we only allow 5 attempts before backing off for a minute,
 * which makes brute force impractical within the TTL).
 *
 * Flow:
 *   1. User runs `scope pair` → CLI POSTs to /api/pair/begin (loopback) and
 *      gets back a code. CLI prints the code to the terminal.
 *   2. SwiftUI client (or another browser) generates a keypair + CSR and
 *      POSTs {code, csr_pem, device_name} to /api/pair/complete.
 *   3. Server validates the code (single-use, TTL, rate limit), signs the
 *      CSR, records the device in devices.json, and returns
 *      {cert_pem, ca_pem, device}.
 *
 * The CLI's `scope pair` blocks until either the code is consumed (resolved
 * via an EventEmitter the begin handler stashes alongside the code) or the
 * TTL elapses.
 */

import { randomInt, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

const CODE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;

/** Generate a 6-digit numeric code as a zero-padded string. */
export function generateCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

class PendingCodes {
  constructor() {
    this.codes = new Map(); // code -> { expiresAt, ee }
    this._sweepTimer = null;
  }

  _startSweeper() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this.sweep(), 30_000);
    this._sweepTimer.unref?.();
  }

  _stopSweeperIfIdle() {
    if (this.codes.size === 0 && this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  sweep(now = Date.now()) {
    for (const [code, info] of this.codes) {
      if (info.expiresAt <= now) {
        info.ee.emit('expired');
        this.codes.delete(code);
      }
    }
    this._stopSweeperIfIdle();
  }

  /**
   * Issue a new code. Returns { code, expiresAt, waitFor }. `waitFor` is a
   * Promise that resolves when the code is consumed (with the consume result)
   * or rejects on expiry.
   */
  issue({ now = Date.now() } = {}) {
    this.sweep(now);
    const code = generateCode();
    const expiresAt = now + CODE_TTL_MS;
    const ee = new EventEmitter();
    this.codes.set(code, { expiresAt, ee });
    this._startSweeper();
    const waitFor = new Promise((resolve, reject) => {
      ee.once('consumed', resolve);
      ee.once('expired', () => reject(new Error('pairing code expired')));
      ee.once('cancelled', () => reject(new Error('pairing cancelled')));
    });
    return { code, expiresAt, waitFor };
  }

  /**
   * Look up + remove a code in constant time. Returns the code's EventEmitter
   * on match, or null on miss. The middleware emits 'consumed' on the EE with
   * the result payload so the CLI's waitFor() resolves.
   */
  consume(candidate, { now = Date.now() } = {}) {
    this.sweep(now);
    // Linear scan with constant-time compare against each known code prevents
    // timing leaks. The set is small (typically 1 outstanding code).
    let match = null;
    let matchKey = null;
    for (const [code, info] of this.codes) {
      const a = Buffer.from(code);
      const b = Buffer.from(String(candidate).padEnd(code.length).slice(0, code.length));
      if (a.length === b.length && timingSafeEqual(a, b) && code === candidate) {
        match = info;
        matchKey = code;
      }
    }
    if (!match) return null;
    this.codes.delete(matchKey);
    this._stopSweeperIfIdle();
    return match.ee;
  }

  /**
   * Cancel an outstanding code (e.g. CLI was killed before a client paired).
   */
  cancel(code) {
    const info = this.codes.get(code);
    if (!info) return;
    info.ee.emit('cancelled');
    this.codes.delete(code);
    this._stopSweeperIfIdle();
  }

  size() { return this.codes.size; }
}

/** Per-IP sliding-window rate limiter for /api/pair/complete. */
class RateLimiter {
  constructor() {
    this.attempts = new Map(); // ip -> number[] (timestamps)
  }

  /** Record an attempt and return whether it's allowed. */
  check(ip, { now = Date.now() } = {}) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    let arr = this.attempts.get(ip);
    if (!arr) { arr = []; this.attempts.set(ip, arr); }
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (arr.length >= RATE_LIMIT_MAX) {
      return { allowed: false, retryAfterMs: (arr[0] + RATE_LIMIT_WINDOW_MS) - now };
    }
    arr.push(now);
    return { allowed: true };
  }

  reset(ip) { this.attempts.delete(ip); }
  resetAll() { this.attempts.clear(); }
}

/** Construct a fresh pairing context — one per server. */
export function createPairingContext() {
  return {
    pending: new PendingCodes(),
    limiter: new RateLimiter(),
  };
}

export { PendingCodes, RateLimiter };
