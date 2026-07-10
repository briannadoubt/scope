import Foundation

// MARK: - SyncEngine (SCP-135)
//
// Dormant offline-replica sync infrastructure for one workspace against the hub
// (ADR 0002, ADR 0005):
//
//   * maintains a local event log + persisted ULID cursor (via `SyncStore`),
//   * pulls events after the cursor on connect (paginating until `more==false`),
//   * pushes locally-created events — status claims IMMEDIATELY (latency-
//     critical agent-collision path, ADR 0002 §4), the offline backlog BATCHED,
//   * applies optimistically before the server ack,
//   * consumes `renumbered` notices to rewrite DISPLAY ids in place WITHOUT
//     dropping ULID identity.
//
// The shipping app currently renders `/api/board` snapshots and uses the live
// event stream as a coarse refresh signal. This engine is intentionally not
// wired into `AppStore` until mobile needs offline-originated writes and local
// event replay. It stays decoupled from `HubClient` through `SyncTransport` so a
// future replica mode can be tested with a fake transport.

// MARK: - Transport

/// The network surface the engine needs. `HubClient` can satisfy this with a
/// thin extension so the engine never imports URLSession details and stays
/// unit-testable with a fake transport.
protocol SyncTransport: Sendable {
    /// `GET /api/sync/pull?since=<cursor>&limit=<limit>`
    func pull(since cursor: String?, limit: Int) async throws -> PullResponse
    /// `POST /api/sync/push { events }`
    func push(_ events: [SyncEvent]) async throws -> PushResponse
}

// MARK: - Delegate

/// How the engine reports state changes back to the app layer.
///
/// Modeled as `@MainActor`-isolated closures rather than a delegate protocol so
/// the callbacks are `Sendable` across the engine's actor boundary and run on
/// the main actor — exactly where `AppStore` (an `@MainActor @Observable`) would
/// mutate its published state if replica mode is enabled.
struct SyncHandlers: Sendable {
    /// Newly-applied events (from a pull, or a local enqueue) that the app
    /// should fold into its projections. Already deduped by ULID.
    let didApply: @MainActor @Sendable ([SyncEvent]) -> Void

    /// Display-number reassignments from a push. The app must rewrite the
    /// rendered key (`KEY-from` → `KEY-to`) for the ticket identified by
    /// `notice.ticketId` WITHOUT changing its ULID identity.
    let didRenumber: @MainActor @Sendable ([RenumberNotice]) -> Void

    init(
        didApply: @escaping @MainActor @Sendable ([SyncEvent]) -> Void = { _ in },
        didRenumber: @escaping @MainActor @Sendable ([RenumberNotice]) -> Void = { _ in }
    ) {
        self.didApply = didApply
        self.didRenumber = didRenumber
    }
}

// MARK: - Engine

actor SyncEngine {

    private let store: SyncStore
    private let transport: SyncTransport
    private let handlers: SyncHandlers

    /// Locally-created events awaiting push (offline backlog). Persisted in the
    /// log immediately on enqueue; this queue tracks which ids still need to go
    /// up. On a confirmed push (accepted ∪ duplicates) they're dropped.
    private var pendingPush: [SyncEvent] = []

    private let pullLimit: Int

    /// Serializes push attempts so an immediate status claim and a backlog
    /// flush can't race onto the wire and double-send.
    private var pushInFlight = false

    init(
        store: SyncStore,
        transport: any SyncTransport,
        handlers: SyncHandlers,
        pullLimit: Int = 1000
    ) {
        self.store = store
        self.transport = transport
        self.handlers = handlers
        self.pullLimit = pullLimit
    }

    // MARK: - Pull (on connect)

    /// Pull everything after the persisted cursor, paginating until the server
    /// reports no more pages. Applies each page optimistically (folds into the
    /// app) and advances the cursor. Safe to call repeatedly (e.g. on every
    /// reconnect) — union semantics make re-pulled ids no-ops.
    func pullOnConnect() async throws {
        var cursor = await store.cursor()

        // Count-guard / backfill detection (ADR 0002 §1): if the server's total
        // count is below what we already hold, an event landed *below* our
        // watermark (e.g. clock skew). Re-bootstrap from empty so we don't miss
        // it — id-range pulls can't see events under the cursor.
        let localCount = (try? await store.allEvents().count) ?? 0

        while true {
            let resp = try await transport.pull(since: cursor, limit: pullLimit)

            if cursor != nil, resp.count < localCount {
                // Backfill detected. Reset local sync state and restart from
                // bootstrap. Done once; the next loop iteration uses since=nil.
                try await store.reset()
                cursor = nil
                continue
            }

            let applied = try await store.append(resp.events)
            try await store.setCursor(resp.cursor)
            cursor = resp.cursor

            if !applied.isEmpty {
                await deliverApplied(applied)
            }
            if !resp.more { break }
        }
    }

    // MARK: - Push (local writes)

    /// Enqueue a locally-created status-claim event and push it IMMEDIATELY.
    /// This is the latency-critical agent-collision path (ADR 0002 §4): other
    /// agents must see `ticket → in_progress` before any branch/commit exists.
    ///
    /// The event is appended to the local log and applied optimistically first,
    /// so the UI reflects the claim instantly even if the network is down; the
    /// push then best-effort flushes it (and any backlog) to the hub.
    func enqueueStatusClaim(_ event: SyncEvent) async throws {
        try await enqueueLocal([event])
        await flush()
    }

    /// Enqueue locally-created backlog events (anything that isn't a latency-
    /// critical status claim). Applied optimistically and appended to the log;
    /// the actual push is BATCHED — call `flush()` when online (e.g. on
    /// reconnect) to send the accumulated backlog in one request.
    func enqueueBacklog(_ events: [SyncEvent]) async throws {
        try await enqueueLocal(events)
    }

    /// Append local events to the log, apply optimistically, and mark them for
    /// push. Shared by the status-claim and backlog paths.
    private func enqueueLocal(_ events: [SyncEvent]) async throws {
        let fresh = try await store.append(events)
        guard !fresh.isEmpty else { return }
        pendingPush.append(contentsOf: fresh)
        await deliverApplied(fresh)
    }

    /// Push the pending backlog to the hub. Idempotent and retry-safe: a known
    /// ULID comes back in `duplicates` and is still cleared from the queue.
    /// No-op when there's nothing pending or a push is already in flight.
    @discardableResult
    func flush() async -> Bool {
        guard !pushInFlight, !pendingPush.isEmpty else { return false }
        pushInFlight = true
        defer { pushInFlight = false }

        let batch = pendingPush
        do {
            let resp = try await transport.push(batch)

            // Anything the server has now (newly accepted OR already a
            // duplicate) is durably uploaded — drop it from the queue.
            let settled = Set(resp.accepted).union(resp.duplicates)
            pendingPush.removeAll { settled.contains($0.id) }

            // Advance the cursor to the server's post-union high-water mark.
            try? await store.setCursor(resp.cursor)

            // Apply renumber notices in place (display id only; ULID unchanged).
            if !resp.renumbered.isEmpty {
                await deliverRenumber(resp.renumbered)
            }
            return true
        } catch {
            // Leave the queue intact for the next flush (offline/transient).
            return false
        }
    }

    /// Whether there is locally-created work still waiting to upload.
    func hasPendingPush() -> Bool { !pendingPush.isEmpty }

    // MARK: - Delegate hops

    private func deliverApplied(_ events: [SyncEvent]) async {
        let handlers = self.handlers
        await MainActor.run { handlers.didApply(events) }
    }

    private func deliverRenumber(_ notices: [RenumberNotice]) async {
        let handlers = self.handlers
        await MainActor.run { handlers.didRenumber(notices) }
    }
}
