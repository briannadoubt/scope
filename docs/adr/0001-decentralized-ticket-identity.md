# ADR 0001 — Decentralized ticket identity & conflict resolution (SCP-110)

> Status: **accepted (design)**. Implements the conflict semantics the
> event-sourced store (SCP-106) depends on. Shapes the `ticketId` field that
> SCP-107's events carry and that SCP-108/109 read and write.

## Context

Today a ticket's identity is `KEY-N` (e.g. `SCP-42`), where `N` comes from a
single monotonic counter, `workspace.next_ticket_number`, handed out by
`nextTicketId()` in `db.js`. That counter is a **centralized consensus value**:
it only works because exactly one process allocates from it.

In the decentralized model two replicas can be offline at once. Both call
`nextTicketId()`, both get `SCP-107`, both emit a `ticket.create` for `SCP-107`.
On merge the log now has two creates claiming the same identity, and every
`ticket.set_field`/`relation.add` that says `SCP-107` is ambiguous. That is the
one coordination hazard the whole "merge by union of events" scheme rests on.

The tension is fundamental: **a small sequential integer is inherently a
consensus value.** You cannot simultaneously have an id that is (a) globally
unique with zero coordination and (b) a short human-friendly sequence. So we
stop asking one token to be both.

## Decision

Split identity from display.

### 1. Identity = ULID

Every ticket gets a **ULID** at creation (`src/event-schema.js#ulid`), minted
locally with no coordination. This ULID is the ticket's permanent identity:

- It is the value of `ticketId` in **every** event (`ticket.create`,
  `ticket.set_field`, `ticket.delete`, `comment.add`) and of `fromId`/`toId` in
  relation events.
- `parentId` references a parent by ULID.
- It never changes and never collides across replicas.

### 2. Display number = locally allocated, deterministically de-collided

The human-facing `SCP-42` becomes a *display* attribute, not identity:

- `ticket.create` carries `number` (a locally-allocated integer) and
  `keyPrefix` (captured at create time, so a later `workspace.set key=...` never
  renumbers existing tickets — consistent with the current "existing tickets
  keep their prefix" guardrail).
- The human id is derived: `humanId = ${keyPrefix}-${resolvedNumber}`.
- **Resolution at replay** (deterministic, identical on every peer): process all
  `ticket.create` events in canonical order (`compareEvents`: ts → ULID id).
  Track used numbers. For each create:
  - if its requested `number` is free, it keeps it;
  - otherwise it is bumped to `max(usedNumbers) + 1`.

  Because canonical order is identical on every replica, every replica computes
  the identical assignment. The **canonically-earliest** claimant of a number
  always keeps it.

### 3. Why this beats pure projection numbering

A pure "assign 1,2,3… by creation order at replay" scheme reshuffles many
tickets' numbers on every merge (insert one early-timestamped ticket and
everything after it shifts). Under this decision a number **only ever moves for
a real collision**, and only for the *losing* create — which, by construction,
is a ticket made on a replica that hadn't synced yet, so no collaborator has
ever seen that number. Everything that has been shared keeps its number
permanently. References in commit messages / PR titles to a shared `SCP-42`
stay valid.

The residual, accepted cost: if two people *both* reach `SCP-42` while offline
and both push, the canonical loser's local `SCP-42` becomes (say) `SCP-58` after
they pull. Replay emits a `renumbered SCP-42 → SCP-58` notice so it's visible,
not silent. This is rare, bounded, and infinitely preferable to a corrupt db.

### 4. `next_ticket_number` stays — as a local hint

Each replica keeps its own `next_ticket_number` to choose a *requested* number
at create time. On replay a replica advances it past the highest number it has
seen, which minimizes future collisions. It is no longer a source of truth,
just a local allocator seed.

## The rest of the conflict model

Identity is the hard part; the remaining rules fall out of "replay events in
canonical order":

- **Scalar fields** (`status`, `title`, `priority`, `parentId`, `branch`,
  `prUrl`, `assignee`): **last-writer-wins** by canonical order. Replaying
  `ticket.set_field` in `compareEvents` order means the event with the newest
  `ts` (ties broken by ULID `id`) is applied last and therefore wins. No special
  case — LWW is just "apply in order."
- **`labels`**: treated as a scalar (whole-array LWW) for now. A future story
  could model add/remove label as set operations; out of scope here.
- **Additive sets** (`tickets`, `comments`): grow-only union. Two creates / two
  comments never conflict; the union contains both. Comment ids are ULIDs so the
  union is order-stable.
- **Relations**: `relation.add` and `relation.remove` are add/remove on a set
  keyed by `(fromId, toId, type)`. Applied in canonical order, so the last
  add-or-remove for a given key wins. Replay materializes the inverse relation
  (matching `addRelation`'s two-direction write today).
- **Removals are tombstones, not vacuums** (`ticket.delete`, `relation.remove`):
  they are events applied in order, never a retroactive erase of earlier events.
  A delete that is canonically-later than an edit wins; an edit that is
  canonically-later than a delete "resurrects" the field on a live ticket only
  if the ticket itself isn't tombstoned. Document the rule: a tombstoned ticket
  stays deleted regardless of later `set_field` events for it (deletes are
  terminal).

## Clock skew

LWW keys on wall-clock `ts`, so a replica with a fast clock can make its edits
win. This is the standard, accepted cost of zero-coordination LWW. `compareEvents`
is the single chokepoint where a future Lamport/HLC clock would slot in if we
ever need causal ordering; nothing else in replay would change.

## Consequences for SCP-107 / 108 / 109 / 113

- **SCP-107 format**: `ticketId` is a ULID (not `KEY-N`). `ticket.create` gains
  `number` and `keyPrefix`. Done in this change.
- **SCP-108 (emit)**: `createTicket` mints a ULID + requests a local number;
  all other ops reference the ULID.
- **SCP-109 (replay)**: runs the display-number resolver and applies events in
  `compareEvents` order.
- **SCP-113 (migration)**: each existing `KEY-N` ticket is assigned a fresh
  ULID identity; its existing `N` is preserved as the display number (no
  renumbering of historical tickets); existing `parent_id`/relation references
  are rewritten from `KEY-N` to the new ULID in the synthesized events.

## Reference implementation

`src/identity.js`:
- `resolveDisplayNumbers(createEvents)` — the pure, deterministic resolver
  above; returns `{ assignments: Map<ticketId,{number,keyPrefix,humanId}>,
  renumbered: [{ticketId, from, to}] }`.
- `humanId(keyPrefix, number)` — `${keyPrefix}-${number}`.
