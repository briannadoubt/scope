/**
 * Decentralized ticket identity — the deterministic display-number resolver
 * specified in docs/adr/0001-decentralized-ticket-identity.md (SCP-110).
 *
 * Ticket *identity* is a ULID (collision-free, zero coordination). The
 * human-facing `KEY-N` is a *display* number: allocated locally at create time,
 * then de-collided here at replay so every replica computes the identical
 * assignment from the same set of create events.
 */

import { compareEvents } from './event-schema.js';

/** Human-facing id, e.g. ("SCP", 42) -> "SCP-42". */
export function humanId(keyPrefix, number) {
  return `${keyPrefix}-${number}`;
}

/**
 * Assign display numbers to tickets deterministically.
 *
 * Processes `ticket.create` events in canonical order (compareEvents). Each
 * create keeps its requested `number` if free; otherwise it is bumped to
 * `max(usedNumbers) + 1`. The canonically-earliest claimant of a number always
 * wins, so a number only ever moves for a genuine collision — and only for the
 * later (unshared) create.
 *
 * @param {Array<object>} createEvents - events with kind 'ticket.create'
 * @returns {{
 *   assignments: Map<string, {number: number, keyPrefix: string, humanId: string}>,
 *   renumbered: Array<{ticketId: string, from: number, to: number}>
 * }}
 */
export function resolveDisplayNumbers(createEvents) {
  const creates = createEvents
    .filter((e) => e.kind === 'ticket.create')
    .slice()
    .sort(compareEvents);

  const assignments = new Map();
  const renumbered = [];
  const used = new Set();
  let maxUsed = 0;

  for (const e of creates) {
    const { ticketId, number: requested, keyPrefix } = e.payload;
    let number = requested;
    if (used.has(number)) {
      number = maxUsed + 1; // bump past everything assigned so far
      renumbered.push({ ticketId, from: requested, to: number });
    }
    used.add(number);
    if (number > maxUsed) maxUsed = number;
    assignments.set(ticketId, {
      number,
      keyPrefix,
      humanId: humanId(keyPrefix, number),
    });
  }

  return { assignments, renumbered };
}

/**
 * The seed value a replica should set its local `next_ticket_number` to after
 * replay, so freshly-created tickets are unlikely to collide: one past the
 * highest assigned number.
 */
export function nextNumberSeed(assignments) {
  let max = 0;
  for (const { number } of assignments.values()) if (number > max) max = number;
  return max + 1;
}
