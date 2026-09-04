# Coordinator readiness and compact responses

Use `scope --json capabilities` to detect `declaredRepositoryIntent` and
`compactCoordinatorView`. Existing `ready`, `ready --plan`, and their HTTP forms
retain their default JSON shapes. The new view is opt-in:

```sh
scope --json ready --plan --compact --parent EPIC-ID --capabilities cpp,python
scope --json ready --plan --compact --cursor SNAPSHOT:OFFSET
scope --json ready --plan --compact --since SNAPSHOT
```

Repeat the same parent/capability filters on every continuation. `--budget-bytes`
bounds minified JSON **data**, excluding envelope/pretty-print overhead (default
16,384; range 2,048–1,048,576). HTTP uses `plan=true&compact=true`, `budgetBytes`,
`cursor`, and `since` on `/api/agent/ready`. The library exposes `coordinatorView`.

`coordinator-v1` returns ordered `{section,value}` records and totals for every
section. Conflicts, unresolved ownership, deferred tickets, and blockers precede
ticket summaries and parallel groups. Accumulate pages until `complete:true`;
never dispatch from an incomplete snapshot. No conflict, blocker, or group is
silently dropped. One oversized record returns `COORDINATOR_RECORD_TOO_LARGE`
with a required byte estimate; increase the budget or request full detail.
Titles alone may be abbreviated, explicitly flagged by `titleAbbreviated`.

A cursor binds the entire compact snapshot, including active lease state and
filter parameters. A change produces `STALE_CURSOR`: restart and discard the
old partial snapshot. `--since` is conditional snapshot refresh, not an event
cursor: an equal snapshot returns `unchanged:true` with no repeated records.
For event-level incremental updates use the existing `watch --since EVENT-ID`.
For narratives, complete verification output, commits and evidence use
`ready TICKET-ID`, `context TICKET-ID --budget 3000`, and `handoff show TICKET-ID`.
The compact projection reduces output/context cost; it does not yet avoid full
execution projection work internally or provide server-side snapshot caching.

## Explicit ownership

Slash-containing prose such as `door/obstruction`, `AS-174/175`, and
`quit/relaunch` is not path intent. Filename-like references in ticket text are
suggestions only. Historical leases are observations only. Neither certifies
complete ownership; both remain in `unresolvedIntent` until a planner declares
intent using existing contracts:

```sh
scope contract set TICKET-ID --policy '{"repositoryIntent":{"files":["Source/Door.cpp"],"reads":["Source/Credentials.h"],"outputs":["Build/DoorProbe"],"worktree":"/absolute/worktree"}}' --by planner
```

`policy.files` and `policy.repositoryFiles` remain supported for existing
source-write declarations. Structured `files` are source writes, `reads` are
shared-interface dependencies, and `outputs` are generated writes relative to
`worktree` (absolute output paths are also supported). Omitting the worktree
uses a shared relative namespace, conservatively detecting matching outputs.
Use canonical absolute worktree/output locations; symlink aliases and shared
physical paths on different hosts are not discovered automatically.

Source-write conflicts remain conflicts across worktrees because integration
shares those paths. Read/read sharing is safe; a source writer conflicts with
an interface reader. Outputs at different physical worktree locations are
independent. Normalization removes `./`, redundant separators and trailing
slashes. Directory/descendant overlaps are detected. Wildcards and escaping
`../` ownership remain unresolved; enumerate concrete paths/directories.
An intentionally empty complete declaration requires `complete:true`.

Live leases add observed files to declared intent. Active workers with no known
intent make every group unsafe and appear in `unresolvedActiveIntent`.
Groups are alternative disjoint batches; do not run multiple groups together.
Planning is advice at a snapshot, not a reservation. Recheck and atomically
claim work before dispatch. Ordinary file overlaps remain warnings unless
`exclusiveFiles` is requested by either participant. Claim admission uses the
same declared output/interface overlaps as planning. Ticket dependencies remain `blocked_by` relations.

## Delivery and acceptance

Compact output reuses ticket `status`, execution `phase`, attempt/lease IDs,
handoff ID and verification counts. `handed_off` means a durable transfer;
`succeeded` means worker attempt success. Neither proves integration or game
acceptance. `verification.satisfied` evaluates only the configured contract;
an empty contract is not an acceptance claim.

Use separate implementation, integration, and acceptance tickets when those
are different deliverables. Link their dependencies and configure each scope's
verification commands. Worker `attempt finish` moves work to review; `complete`
is for satisfying that ticket's contract. Record exact integration commits and
acceptance artifacts in existing evidence. Handoff/discovery blocker records
retain provenance and can be historical; only dependency records are automatic
readiness gates. This avoids inventing a second delivery-status state machine.

## Evidence from current use

The task **Resume AS-157 with Unreal MCP** showed repeated per-ticket execution
reads and a `ready` versus `ready --plan` JSON-shape mismatch. Its AS-189 outcome
also correctly distinguished passing instrumentation from the 67/69 native
suite with unpublished assets. These observations motivate one opt-in compact
view and explicit contract-scoped completion, not automatic production claims.

**Evaluate Opus Sol collaboration** reported lease expiry/ownership mistakes,
CLI p95 around 1.3–1.6 seconds in recent intervals, and an older bridge-delivery
failure with four pending messages after six attempts. Empty monitored inboxes
and an unbound monitor workspace do not establish end-to-end delivery health.
This change does not repair or claim to validate that bridge incident.

## Reproducible size check

`node --import=./test/setup.js scripts/benchmark-coordinator.mjs` creates and
removes an isolated 12-worker fixture with repeated durable handoff narratives.
Against the baseline runtime at `6921c276deebf3092d0b612ae44b64bacf238fb5`, full
minified data was 1,900,175 bytes (~475,044 tokens at four characters/token),
versus 7,864 bytes (~1,966 tokens) for one compact page and 449 bytes for an
unchanged refresh. This is a synthetic response-size comparison, not a measured
speedup on Alder or a tokenizer-specific token count.

## Phase resources (dogfood.2, event format 3)

A phase reservation is a list of `{key,phase,units,capacity}` allocations on the
existing work lease. It introduces no worker, extra attempt, scheduling daemon,
or delivery status. Declare requirements in the existing contract policy:

```json
{
  "resourceRequirements": {
    "build": [{"key":"host:mac:engine-build","capacity":1,"units":1}],
    "capture": [{"key":"host:mac:foreground"}],
    "test": [{"key":"host:mac:cpu-slots","capacity":2,"units":1}]
  }
}
```

Keys are workspace-scoped identifiers. Include the physical host, engine
installation, checkout, or capture-surface domain as needed; nothing is
engine-specific. Capacity and units default to one. All active users of a key
must agree on capacity; disagreement is an explicit `capacity_mismatch` blocker.
Capacity declarations are coordinator policy, not host measurement.

```sh
scope --json resource ready TICKET-ID --phase build
scope --json resource acquire LEASE-ID --agent AGENT --phase build
# Native host/wrapper performs the build after successful acquisition.
scope --json resource release LEASE-ID --agent AGENT --phase build
```

The owner must hold the exact active work lease. A phase acquires all required
resources atomically or none; one blocked phase does not change authoring
readiness or prevent acquisition of an independent phase. `RESOURCE_UNAVAILABLE`
returns holders, requested/used units and capacities. Compact `phases` records
show available/held/blocked phase admission independently of ownership groups.
HTTP and library equivalents are exposed alongside the CLI.

Normal work-lease renewal extends the reservations. Explicit phase release
keeps other phases; work completion, handoff, release or expiry makes all its
allocations inactive. Stale lease handles cannot release a replacement worker's
resources. On `LEASE_EXPIRED`, read execution state and reclaim work if
appropriate; never retry the old lease ID. The wrapper must stop or fence
expired execution before another process uses the physical resource. Expiry is
not evidence that an engine process has exited.

**Authority boundary:** acquisition is atomic for callers sharing one SQLite
workspace database, including separate CLI processes and worktrees pointing at
that authority. Use one authoritative `SCOPE_DIR` or the same workspace HTTP
endpoint for each resource domain. Independent/offline replicas cannot provide
a distributed mutex; merging event logs provides history, not mutual exclusion.
Separate checkout databases must not each admit the same physical build domain.
The native engine/checkout wrapper's existing lock remains the final physical
guard. Resource admission does not claim to measure free memory/CPU, create
workers, restart builds, or control the foreground app.

**Compatibility:** this second commit bumps the package to `0.10.0-dogfood.2`,
the SQLite cache schema to 10, and new event writes to format 3. Readers accept
immutable formats 1, 2 and 3. Version-2 readers reject new writes explicitly;
upgrade every writer/reader and any sync server before mutating a shared
workspace with this build. PostgreSQL schema/replay support is included, but
live PostgreSQL tests were skipped locally because no server was reachable.
Do not install this over the running CLI or introduce format-3 writes into Alder
until the coordinated upgrade is arranged. The earlier `8a49c70` commit provides
the ownership/compact fixes alone while retaining event format 2.

Safe Alder adoption: first review/cherry-pick the desired commit boundary and
run the isolated regressions. Enable the compact view only after its capability
flag is present; declare concrete source/read/output ownership for the intended
workers. Preserve implementation, integration and acceptance as separately
verified ticket contracts. Add phase requirements to engine wrappers only after
choosing the shared admission authority and upgrading its readers. No Alder
configuration, workers, native assets, installed CLI, or service was changed by
this work.

The resource-enabled build's isolated benchmark emits 7,875 compact bytes
(~1,969 approximate tokens), or 460 bytes for an unchanged refresh. Its expanded
full view is 1,900,575 bytes; the pre-fix baseline remains 1,900,175 bytes. Final
resource validation ran `npm test`: 378 passed, 70 unavailable-Postgres skips,
zero failures. A subsequent targeted CLI/HTTP/resource/migration pass ran 34/34.
`npm run docs:agent:check` and `git diff --check` passed. The installed executable
was verified separately as `0.10.0-dogfood.1`; it was not replaced.
