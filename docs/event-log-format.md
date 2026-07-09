# Event log format (SCP-107)

> Status: **spec / draft**. Defines the on-disk format that becomes Scope's
> source of truth. Emitting these events from every mutation is SCP-108;
> replaying them into `scope.db` is SCP-109; conflict semantics are SCP-110.

## Why this exists

Today the **materialized snapshot** — the rows in `tickets`,
`ticket_relations`, `ticket_comments` — is the source of truth, and that is
what any file-sync transport (git, iCloud, Dropbox, Syncthing) tries to merge.
A snapshot is the *current answer* with the path that produced it discarded, so
two divergent answers have no common ancestor to reconcile against. SQLite
makes it worse: the file is binary B-tree pages plus a WAL, so git can't even
attempt a textual merge — it corrupts.

The fix is to make an **append-only log of operations** the source of truth and
treat `scope.db` as a disposable cache rebuilt by replaying that log. Appending
is *union-mergeable*: merging two peers' logs is just the union of their event
files, replayed in a deterministic order. There is nothing to 3-way merge and
therefore nothing to corrupt.

## The envelope

Every event is one immutable JSON object with a fixed envelope and a
kind-specific `payload`:

```jsonc
{
  "v": 1,                          // event-format version (integer)
  "id": "01JZ9F2K7QABCD3EFGH4JKMN5", // ULID — globally unique, lexicographically time-sortable
  "ts": "2026-06-02T17:04:11.873Z",  // ISO-8601 UTC wall-clock of the actor that produced it
  "actor": "bri",                  // who caused it (human handle or agent name); never null
  "kind": "ticket.set_field",      // see "Event kinds" below
  "payload": { /* kind-specific, see below */ }
}
```

Rules:

- **Immutable.** An event is never edited or deleted once written. Corrections
  are new events; removals are tombstones (see `ticket.delete`,
  `relation.remove`).
- **`id` is a ULID**, not a UUID. ULIDs sort lexicographically by creation time,
  so the loose event files sort chronologically by filename and ordering needs
  no index. ULIDs are minted locally with no coordination, so two offline peers
  never collide. (Implementation: `src/event-schema.js#ulid`.)
- **`ts` is the actor's wall clock.** It drives last-writer-wins resolution
  (SCP-110). It is intentionally redundant with the ULID's embedded time so the
  log stays human-readable and queryable without decoding ULIDs.
- **`actor` is required.** "Who changed what" is the whole point of the audit
  trail and the LWW tiebreak; an event with no actor is invalid. Use the human
  handle, or the agent's name / `"agent"`.
- **`v` is the format version.** Bump only on a breaking envelope/payload
  change; readers reject an event whose `v` they don't understand rather than
  guessing.

## Canonical ordering

Replay (SCP-109) and conflict resolution (SCP-110) require a *total* order that
every peer computes identically from the same set of events:

```
compareEvents(a, b) = byTimestamp(a.ts, b.ts)   // primary: wall-clock
                   ?? byId(a.id, b.id)            // tiebreak: ULID (unique + monotonic)
```

`ts` first means "the most recent intent wins". The ULID `id` breaks ties: it is
globally unique (so the comparator never returns "equal" for distinct events)
*and* monotonic within a process (so two events a peer produced in the same
millisecond still sort in the order they happened). `actor` is deliberately
**not** part of the order — tiebreaking on actor name would reorder
same-millisecond events by different actors away from their real sequence (e.g.
two comments posted in the same instant). Because `id` alone is a complete total
order after `ts`, nothing more is needed.

> Clock skew is a known limitation, not a bug to solve here: a peer with a fast
> clock can make its edits "win". That is the accepted cost of zero
> coordination, and it is the same tradeoff every LWW local-first system makes.
> A future story may layer Lamport/HLC counters into `ts`; the comparator is the
> single place that would change.

## On-disk layout

New workspaces resolve their event log through storage metadata in
`.scope/workspace.json`. The default is quiet machine-local storage:

```
~/.scope/workspaces/<workspace-id>/
  scope.db            # cache — rebuildable, never committed
  scope.db-wal
  scope.db-shm
  events/             # SOURCE OF TRUTH
    01JZ9F2K7Q....json   # one event per file, named <id>.json
    01JZ9F2M3R....json
    ...
```

Git-carried events remain available with `scope init --git-events` or
`scope events move-to-git`:

```
.scope/
  workspace.json      # storage marker
  scope.db            # cache — gitignored, rebuildable, never shared
  events/             # SOURCE OF TRUTH — tracked / synced in git-events mode
```

**One event per file** is the load-bearing decision. Because each filename is a
globally-unique ULID, two peers appending concurrently *never write the same
path*. A merge — whether via `git pull`, iCloud, or Syncthing — only ever adds
new files. There is no line-level conflict to resolve and no partial-write
corruption of a shared append target. (A single append-only NDJSON log was
considered and rejected for exactly this reason: concurrent appends collide on
the same bytes.)

Each file contains exactly one event object (pretty-printed is fine; it's small
and diff-friendly). Writes are atomic: write to `events/.<id>.json.tmp`, then
`rename()` into place, so a reader or a sync daemon never observes a half-written
event.

At very large scale a flat directory can be sharded by ULID prefix
(`events/01JZ/01JZ9F2K7Q....json`); the prefix is derived from the id, so this
is a transparent storage detail and does not change the format. Not needed at
current scale (~100s of tickets).

## Event kinds

Identity note (settled by SCP-110, see
[adr/0001-decentralized-ticket-identity.md](adr/0001-decentralized-ticket-identity.md)):
events reference tickets by **`ticketId`**, which is a **ULID** — the ticket's
permanent, collision-free identity, minted locally with no coordination. The
human-facing `KEY-N` is *not* identity; it is a display attribute carried on
`ticket.create` as `number` + `keyPrefix` and de-collided deterministically at
replay (`src/identity.js#resolveDisplayNumbers`). Comment ids (`commentId`) are
likewise ULIDs. `parentId`, `fromId`, `toId` all reference tickets by ULID.

### `workspace.init`
Emitted once when a workspace is created. Payload:
```jsonc
{ "key": "SCP", "name": "Scope CLI", "description": "", "overview": "" }
```

### `workspace.set`
Any subset of the mutable workspace fields. Payload (all optional, ≥1 present):
```jsonc
{ "key": "SCP", "name": "...", "description": "...", "overview": "..." }
```

### `ticket.create`
Mirrors `createTicket()` in `repo.js`. Payload:
```jsonc
{
  "ticketId": "01JZ9F2K7QABCD3EFGH4JKMN5", // ULID identity (permanent)
  "number": 42,                   // locally-allocated display number (de-collided at replay)
  "keyPrefix": "SCP",             // captured at create; key changes never renumber existing tickets
  "ticketType": "story",          // epic | story | bug
  "title": "OAuth login",
  "description": "",
  "status": "backlog",            // backlog|todo|in_progress|in_review|done|cancelled
  "priority": "medium",           // low|medium|high|urgent
  "parentId": "01JZ9F2K6...",     // parent ULID, or null
  "branch": null,
  "prUrl": null,
  "assignee": null,
  "labels": []
}
```
The human id is `${keyPrefix}-${resolvedNumber}` (e.g. `SCP-42`), where
`resolvedNumber` comes from the deterministic resolver — see
[adr/0001](adr/0001-decentralized-ticket-identity.md).

### `ticket.set_field`
**One event per field changed.** Mirrors each field write inside
`updateTicket()`. Payload:
```jsonc
{
  "ticketId": "SCP-42",
  "field": "status",   // title|description|status|priority|parentId|branch|prUrl|assignee|labels
  "value": "in_progress",
  "prev": "todo"        // OPTIONAL, informational only — replay MUST ignore it
}
```
`value` carries the new value in its natural JSON type (`labels` is an array,
not a JSON string). `prev` is recorded for human-readable history/debugging and
is **never** consulted by replay — replay is order-based LWW, not a diff apply,
so it must not depend on the previous value matching.

### `ticket.delete`
Tombstone. Mirrors `deleteTicket()`. Payload:
```jsonc
{ "ticketId": "SCP-42" }
```
Replay marks the ticket deleted; it does not vacuum prior events. A delete that
arrives before some of the ticket's other events still resolves coherently
because the tombstone is applied in timestamp order with everything else.
(Cancelling a ticket is *not* a delete — it's `ticket.set_field status=cancelled`,
which preserves the card and its history.)

### `comment.add`
Mirrors `addComment()`. Payload:
```jsonc
{ "ticketId": "SCP-42", "commentId": "01JZ9...", "author": "bri", "body": "..." }
```
Comments are purely additive — two peers adding comments can never conflict, the
union just contains both. `commentId` is a ULID so the union is also
order-stable.

### `relation.add`
Mirrors `addRelation()` — records the **single user intent**; replay
materializes both the relation and its inverse (the way `addRelation` writes
both directions today). Payload:
```jsonc
{ "fromId": "SCP-2", "toId": "SCP-7", "type": "blocked_by" }
```

### `relation.remove`
Tombstone for a relation; replay removes both directions. Payload:
```jsonc
{ "fromId": "SCP-2", "toId": "SCP-7", "type": "blocked_by" }
```

## Validation

`src/event-schema.js` is the executable form of this document:

- `EVENT_FORMAT_VERSION` — current `v`.
- `EVENT_KINDS` — the closed set of legal `kind` values.
- `ulid()` — mint a new lexicographically-sortable id with no dependency.
- `makeEvent(kind, payload, { actor, ts? })` — build a validated envelope.
- `validateEvent(evt)` — throw on anything this spec forbids (unknown kind,
  missing actor, bad enum, malformed payload, future `v`). Reused by the writer
  (SCP-108, reject bad writes) and the reader (SCP-109, reject corrupt files).
- `compareEvents(a, b)` — the canonical total order above.

We deliberately **do not** add `zod`: it isn't a current dependency, and a small
hand-written validator keeps the install footprint minimal while giving us
clearer, domain-specific error messages. Enum values are imported from
`repo.js` (`SCHEMA_STATUSES`, `SCHEMA_PRIORITIES`, `SCHEMA_TICKET_TYPES`,
`SCHEMA_RELATION_TYPES`) so the event format and the DB constraints can never
drift apart.
