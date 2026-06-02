/**
 * ULID generator — a 26-char, lexicographically time-sortable, globally-unique
 * id with no external dependency. Extracted as a leaf module (imports only
 * node:crypto) so both event-schema.js and db.js can use it without creating an
 * import cycle.
 */

import { randomBytes } from 'node:crypto';

// Crockford base32 (no I, L, O, U). 10 chars encode a 48-bit ms timestamp,
// 16 chars encode 80 bits of randomness — 26 chars total, the standard ULID.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastMs = -1;
let lastRandom = null;

/**
 * Mint a ULID. Monotonic within a process: if two ulids are minted in the same
 * millisecond the random component is incremented so they still sort in
 * creation order.
 *
 * @param {number} [ms] - epoch milliseconds (defaults to now). Injectable for tests.
 * @returns {string}
 */
export function ulid(ms = Date.now()) {
  const time = encodeTime(ms);
  let rand;
  if (ms === lastMs && lastRandom) {
    rand = incrementRandom(lastRandom);
  } else {
    rand = randomBytes(10); // 80 bits
  }
  lastMs = ms;
  lastRandom = rand;
  return time + encodeRandom(rand);
}

function encodeTime(ms) {
  let out = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(bytes) {
  // 10 bytes (80 bits) -> 16 base32 chars (80 bits). Stream the bits out MSB-first.
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out.slice(0, 16);
}

function incrementRandom(bytes) {
  const next = Buffer.from(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] === 0xff) {
      next[i] = 0;
    } else {
      next[i] += 1;
      return next;
    }
  }
  // Overflow (astronomically unlikely): fall back to fresh randomness.
  return randomBytes(10);
}
