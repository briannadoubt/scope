# Event log format

> Status: **implemented**. `src/event-schema.js` is the executable contract;
> `scope --json capabilities` reports the supported version and event kinds.

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
  "v": 2,                          // event-format version (integer)
  "id": "01JZ9F2K7QABCD3EFGH4JKMN5", // ULID — globally unique, lexicographically time-sortable
  "ts": "2026-06-02T17:04:11.873Z",  // ISO-8601 UTC wall-clock of the actor that produced it
  "hlc": "1780429451873-000000",     // hybrid logical clock for deterministic live ordering
  "actor": "bri",                  // who caused it (human handle or agent name); never null
  "model": "gpt-5",                // optional acting model
  "baseRevision": "sha256:...",    // optional state observed before this mutation
  "requestId": "run-42",           // optional durable idempotency fence
  "requestCommand": "ticket edit", // required alongside requestId
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
- **`hlc` is the preferred live ordering key.** Its wall-clock component keeps
  events chronological while its logical counter orders same-millisecond
  mutations. Legacy events without an HLC continue to order by `ts` and `id`.
- **`baseRevision` records observed causality.** Two different field writes
  based on the same revision are sibling intents. Replay still converges via
  deterministic LWW, but also materializes an explicit conflict for an agent to
  inspect and resolve.
- **`actor` is required.** "Who changed what" is the whole point of the audit
  trail and the LWW tiebreak; an event with no actor is invalid. Use the human
  handle, or the agent's name / `"agent"`.
- **`v` is the reader-compatibility boundary.** Current writers emit version 2
  and current readers accept immutable version-1 history plus version 2. The
  expanded transaction and agent vocabulary requires a version-2 reader.
  Readers reject a newer `v` with `UNSUPPORTED_EVENT_FORMAT` and an actionable
  upgrade message rather than treating valid future data as corruption or
  silently projecting an incomplete workspace.

## Reader compatibility and upgrades

Run `scope --json capabilities` before joining a shared workspace. Its
`eventFormat` object advertises `writerVersion`, `readerVersions`, and
`minimumReaderVersion`. Every process that opens, syncs, serves, or writes the
workspace must support at least the writer's minimum reader version.

Scope format 2 continues to read format-1 history; upgrading does not rewrite
the append-only log. Once any format-2 event has been written, do not reopen or
sync that workspace with a format-1-only Scope binary. `scope doctor` reports
newer event files as `incompatibleFiles`, separately from malformed
`corruptFiles`, and refuses cache repair until Scope is upgraded.

Development builds briefly wrote the expanded event vocabulary under `v: 1`.
The format-2 reader accepts those immutable events so existing development
workspaces remain usable, but released mixed-version deployments should rely on
the explicit `v: 2` boundary.

## Canonical ordering

Replay (SCP-109) and conflict resolution (SCP-110) require a *total* order that
every peer computes identically from the same set of events:

```
compareEvents(a, b) = byHlc(a.hlc, b.hlc)       // when both carry an HLC
                   ?? byTimestamp(a.ts, b.ts)   // legacy / compatibility order
                   ?? byId(a.id, b.id)           // globally unique tiebreak
```

`ts` first means "the most recent intent wins". The ULID `id` breaks ties: it is
globally unique (so the comparator never returns "equal" for distinct events)
*and* monotonic within a process (so two events a peer produced in the same
millisecond still sort in the order they happened). `actor` is deliberately
**not** part of the order — tiebreaking on actor name would reorder
same-millisecond events by different actors away from their real sequence (e.g.
two comments posted in the same instant). Because `id` alone is a complete total
order after `ts`, nothing more is needed.

HLCs reduce ambiguity within a producer but do not pretend disconnected clocks
are synchronized. `baseRevision` supplies the missing causal signal for edits
that matter: agents see a conflict instead of silently mistaking LWW for intent.

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
event. The file and containing directory are fsynced before the cache
transaction commits, making the log authoritative across process or power loss.

## Atomic transactions

Compound mutations write member events first with `transactionId` and
`transactionIndex`, then fsync a final `transaction.commit` event listing every
member id. Readers expose a transaction only when the marker and all declared
members are present in the expected order. A crash or partial sync therefore
leaves invisible orphan members, never a half-applied batch. `scope doctor`
reports corrupt files, incomplete transactions, or cache/log divergence;
`scope doctor --repair` rebuilds the cache without deleting source events.

At very large scale a flat directory can be sharded by ULID prefix
(`events/01JZ/01JZ9F2K7Q....json`); the prefix is derived from the id, so this
is a transparent storage detail and does not change the format. Not needed at
current scale (~100s of tickets).

## Event kinds

The complete current list is generated in
[agent-protocol.md](agent-protocol.md). In addition to workspace, ticket,
comment, relation, and artifact events, agent-native projections use:

- `agent.contract.set`
- `agent.lease.claim`, `agent.lease.renew`, `agent.lease.release`
- `agent.attempt.start`, `agent.attempt.finish`
- `agent.discovery.add`
- `agent.plan.revise`
- `agent.conflict.resolve`
- `agent.register`, `agent.heartbeat`
- `agent.message.send`, `agent.message.ack`

`agent.lease.renew` may refresh observed `files`, `worktree`, `branch`, and
`baseSha` fields as an agent learns its actual repository footprint. Structured
handoffs are versioned `agent.discovery.add` records with `type: "handoff"`, so
they remain durable and replayable without adding a separate mutable channel.
Agent messages are addressed immutable envelopes; acknowledgement is a separate
idempotent event. Presence is heartbeat-based and becomes offline when its
projected expiry passes.

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
  "status": "backlog",            // any status id configured in workspace columns
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
(Cancelling a ticket is *not* a delete — it's `ticket.set_field` to a status
whose workspace column has `kind:"cancelled"`, which preserves the card and its
history.)

### `comment.add`
Mirrors `addComment()`. Payload:
```jsonc
{ "ticketId": "SCP-42", "commentId": "01JZ9...", "author": "bri", "body": "..." }
```
Comments are purely additive — two peers adding comments can never conflict, the
union just contains both. `commentId` is a ULID so the union is also
order-stable.

### `artifact.put`
Creates or replaces a self-contained HTML visualization attached to a ticket.
Artifact content is stored inline so ordinary event-log union and remote sync
remain complete. Payload:
```jsonc
{
  "ticketId": "01JZ9F2K7QABCD3EFGH4JKMN5",
  "artifactId": "01JZ9F9P1QABCD3EFGH4JKMN5",
  "name": "latency-dashboard.html",
  "mimeType": "text/html",
  "content": "<!doctype html>..."
}
```
Only `text/html` is accepted and UTF-8 content is capped at 512 KiB. Reusing an
artifact id is last-write-wins in canonical event order.

### `artifact.remove`
Removes an attached artifact by stable id. Payload:
```jsonc
{
  "ticketId": "01JZ9F2K7QABCD3EFGH4JKMN5",
  "artifactId": "01JZ9F9P1QABCD3EFGH4JKMN5"
}
```

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

- `EVENT_FORMAT_VERSION` — version written by current Scope builds.
- `SUPPORTED_EVENT_FORMAT_VERSIONS` — immutable history versions this reader
  can safely project.
- `MINIMUM_READER_EVENT_FORMAT_VERSION` — reader level required for new writes.
- `EVENT_KINDS` — the closed set of legal `kind` values.
- `ulid()` — mint a new lexicographically-sortable id with no dependency.
- `makeEvent(kind, payload, { actor, ts? })` — build a validated envelope.
- `validateEvent(evt)` — throw on anything this spec forbids (unknown kind,
  missing actor, bad enum, malformed payload, future `v`). Unsupported future
  versions use the distinct `UNSUPPORTED_EVENT_FORMAT` compatibility error.
  Reused by the writer (SCP-108, reject bad writes) and reader (SCP-109).
- `compareEvents(a, b)` — the canonical total order above.

We deliberately **do not** add `zod`: it isn't a current dependency, and a small
hand-written validator keeps the install footprint minimal while giving us
clearer, domain-specific error messages. Enum values are imported from
`repo.js` (`SCHEMA_STATUSES`, `SCHEMA_PRIORITIES`, `SCHEMA_TICKET_TYPES`,
`SCHEMA_RELATION_TYPES`) so the event format and the DB constraints can never
drift apart.
