# ADR 0002 — Sync-cursor protocol & reconciliation (SCP-123 / SCP-134)

> Status: **accepted**. Pull/push implemented single-tenant per-workspace in
> SCP-134 (`/api/sync/pull`, `/api/sync/push`). Builds directly on the
> decentralized identity model of [ADR 0001](0001-decentralized-ticket-identity.md)
> and the append-only event log (SCP-106/108). Multi-tenant scoping (SCP-124),
> on-upload authz (SCP-122), large-log snapshot bootstrap (SCP-137), and
> granular fan-out of synced changes (SCP-146) layer on top.

## Context

Hosted Scope (the SCP-120 epic) is **offline-first**: clients keep their own
local event logs and the cloud node is "just another replica" plus a sync
transport. We need a wire protocol that moves events between a client and the
hub and reconciles them — without reintroducing the coordination hazards
ADR 0001 removed.

The validated product driver is **agent-collision avoidance**: parallel coding
agents must see each other's task claims fast, and a status claim
(`ticket -> in_progress`) happens *before* any branch/commit exists for git to
carry. So the realtime/sync channel must carry the pre-commit changes git
structurally cannot.

The key realization that shapes everything below: **reconciliation is not a new
merge algorithm.** Because the log is append-only, ULID-keyed, and replayed by a
pure function of the event *set* in canonical `compareEvents` order (ADR 0001),
the server's job on receiving events is just to add them to its set and re-run
the **same `replayInto` a local replica runs**. A late-arriving, interleaved
batch therefore produces byte-identical state to a local file-union replay, by
construction.

## Decision

### 1. Cursor = ULID high-water mark (+ count guard)

The sync cursor is the maximum ULID `id` a client has durably applied. ULIDs are
globally unique and lexicographically time-sortable, so "events since cursor X"
is a cheap range scan needing **no server-allocated sequence** (which would
reintroduce the consensus value ADR 0001 killed) and **no vector clock** (there
is one canonical replica per tenant). The pull response also returns a `count`
of total events in the log — a guard that lets a client detect *backfill* (an
event with an id below its watermark, e.g. from clock skew) and re-pull/re-snapshot.

Rejected: per-tenant monotonic sequence (consensus value, coordination hazard);
vector clocks (unnecessary with a single canonical replica).

### 2. Endpoints

- `GET /api/sync/pull?since=<ulid>&limit=N` → `{ events, cursor, count, more }`.
  Empty `since` = bootstrap (full log). Pagination is **id-sorted** (not
  canonical `ts,id` order) so the cursor advances monotonically; the client
  replays canonically regardless, so send-order does not affect correctness.
- `POST /api/sync/push { events:[...] }` → `{ accepted, duplicates, renumbered,
  cursor, count }`. Validates the whole batch up front (atomic — a bad event
  lands nothing), unions events onto the log, re-replays, and returns the
  display-number reassignment notices from `replayInto().renumbered`.
- `GET /api/sync/snapshot` (future, SCP-137) — a compacted replay-state blob +
  tail cursor for large-log bootstrap. An optimization only: the event log
  remains the source of truth and any snapshot must be reproducible by replay.

### 3. Idempotency & union semantics

Events are content-addressed by ULID (`<ulid>.json`). Re-pushing a known id is a
confirmed no-op (reported in `duplicates`), so retries and concurrent replica
pushes are safe. This is the same property that makes git/Dropbox file-union
sync work (ADR 0001) — the HTTP transport inherits it.

### 4. Latency posture for agents

Status-claim events are the latency-critical path and should be pushed
individually and immediately; only the offline backlog is batched. The push
emits a coarse `sync.applied` bus notification so connected viewers refresh
(granular per-event fan-out across app servers is SCP-146 / ADR-fan-out).

## Consequences

- **Server reconciliation == local file-union replay**, by construction — no
  bespoke server merge code, and the offline-a-week-then-upload case is correct
  for free.
- Idempotent, retry-safe sync over a dumb HTTP transport.
- **Open / deferred:** multi-tenant scoping of the log + cache (SCP-124);
  on-upload actor authz — verify `event.actor` principal == authenticated
  subject (SCP-122, gates the push path); large-log snapshot bootstrap
  (SCP-137); cross-app-server fan-out of pushed changes (SCP-146 — push
  currently does a full re-replay and a coarse refresh notify); incremental
  replay on tail-append instead of full re-replay (SCP-143).
