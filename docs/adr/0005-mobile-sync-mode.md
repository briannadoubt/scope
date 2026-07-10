# ADR 0005: Mobile Sync Mode

Status: accepted

## Context

The iOS app has two possible ways to follow Scope data:

- act as a true local event-log replica using `SyncEngine` and `SyncStore`
- act as a snapshot client that reads canonical board state from the hub and
  refreshes when live events say something changed

`SyncEngine` and `SyncStore` were built as an offline-first experiment for the
first model. The shipping app currently uses the second model: `AppStore` loads
`/api/board`, keeps the server-provided columns and tickets in memory, and uses
the authenticated event stream as a coarse invalidation signal.

## Decision

The mobile app is a snapshot client for now.

`/api/board` is the canonical mobile read surface. It returns the workspace
columns plus ticket buckets, so web, hosted, and iOS clients render the same
board shape. The event stream is used to notice remote changes quickly and then
refresh that snapshot.

`SyncEngine` and `SyncStore` remain in the app source as dormant experimental
infrastructure for a future offline-replica mode. They are not wired into
`AppStore` until Scope needs mobile-originated offline writes, conflict handling,
and local event replay on device.

## Consequences

- Desktop agents can write local events, sync them to the hosted hub, and the
  mobile app sees them after the hub snapshot refreshes.
- The mobile app avoids maintaining a second event replay implementation on the
  critical path.
- The Settings sync chip should describe the current remote task-sync state from
  `/api/meta`, not imply that the phone itself is pushing a local event log.
- Future work that enables offline mobile writes should wire `SyncEngine` behind
  a deliberate product switch and include conflict UX.
