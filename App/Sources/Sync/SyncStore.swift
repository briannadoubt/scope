import Foundation

// MARK: - SyncStore (SCP-135)
//
// Dormant file-based local event log + persisted ULID cursor for one workspace.
// The shipping app currently renders hub snapshots; see ADR 0005 for why this
// store is not wired into `AppStore` yet.
//
// Layout (under the app container's Application Support dir):
//
//   <AppSupport>/Sync/<workspaceId>/
//       log.ndjson      append-only newline-delimited event envelopes
//       cursor          the ULID high-water mark (plain UTF-8 string)
//
// Mirrors the hub's on-disk model: an append-only, ULID-keyed event log that is
// the source of truth, replayed by a pure function of the event *set*. We use a
// single NDJSON file (one event JSON per line) rather than one file per ULID as
// the hub does — simpler for a single-process client, and union/idempotency is
// enforced in-memory by `knownIds` on append.
//
// The cursor is stored as a small file alongside the log rather than in the
// Keychain: it is non-secret high-water state (the Keychain is reserved for the
// pairing identity/CA in `KeychainStore`), and keeping it next to the log makes
// "reset this workspace's sync state" a single directory delete. See the
// integration notes for the UserDefaults alternative.

actor SyncStore {

    enum SyncStoreError: LocalizedError {
        case ioFailure(String)
        var errorDescription: String? {
            switch self {
            case .ioFailure(let m): return "Sync store error: \(m)"
            }
        }
    }

    let workspaceId: String
    private let dir: URL
    private let logURL: URL
    private let cursorURL: URL

    /// In-memory union guard so re-applying/re-pulling a known ULID is a no-op,
    /// matching the hub's content-addressed idempotency (ADR 0002 §3).
    private var knownIds: Set<String> = []

    private let coder = SyncWire.coder

    // MARK: Init

    /// - Parameters:
    ///   - workspaceId: scopes the on-disk directory; each workspace has its own
    ///     log + cursor.
    ///   - containerRoot: override for tests. Defaults to the app's Application
    ///     Support directory.
    init(workspaceId: String, containerRoot: URL? = nil) throws {
        self.workspaceId = workspaceId
        let root = try containerRoot ?? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        self.dir = root
            .appendingPathComponent("Sync", isDirectory: true)
            .appendingPathComponent(workspaceId, isDirectory: true)
        self.logURL = dir.appendingPathComponent("log.ndjson")
        self.cursorURL = dir.appendingPathComponent("cursor")

        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.knownIds = (try? Self.readIds(at: logURL, coder: coder)) ?? []
    }

    // MARK: - Cursor

    /// The persisted ULID high-water mark, or nil if we've never synced
    /// (bootstrap → pull the full log).
    func cursor() -> String? {
        guard let data = try? Data(contentsOf: cursorURL),
              let s = String(data: data, encoding: .utf8)?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              !s.isEmpty else { return nil }
        return s
    }

    /// Persist a new cursor. Only advances; a lower value is ignored so a
    /// late/out-of-order page can never rewind the watermark (ADR 0002 §1
    /// monotonicity).
    func setCursor(_ ulid: String?) throws {
        guard let ulid else { return }
        if let current = cursor(), ulid <= current { return }
        do {
            try Data(ulid.utf8).write(to: cursorURL, options: .atomic)
        } catch {
            throw SyncStoreError.ioFailure("write cursor: \(error.localizedDescription)")
        }
    }

    // MARK: - Log

    /// All locally-known events, in ULID (id) ascending order. The caller
    /// replays canonically; this convenience sort just gives a stable order.
    func allEvents() throws -> [SyncEvent] {
        let events = try Self.readEvents(at: logURL, coder: coder)
        return events.sorted { $0.id < $1.id }
    }

    /// True if this ULID is already in the local log.
    func contains(_ id: String) -> Bool { knownIds.contains(id) }

    /// Append events to the log, skipping any whose ULID we already have.
    /// Returns the events that were genuinely new (the ones to optimistically
    /// apply / fold into projections). Idempotent by ULID — union semantics.
    @discardableResult
    func append(_ events: [SyncEvent]) throws -> [SyncEvent] {
        let fresh = events.filter { !knownIds.contains($0.id) }
        guard !fresh.isEmpty else { return [] }

        var blob = Data()
        for e in fresh {
            let line = try coder.encoder.encode(e)
            blob.append(line)
            blob.append(0x0A) // '\n'
        }
        do {
            try Self.appendData(blob, to: logURL)
        } catch {
            throw SyncStoreError.ioFailure("append log: \(error.localizedDescription)")
        }
        for e in fresh { knownIds.insert(e.id) }
        return fresh
    }

    /// Wipe this workspace's local sync state (log + cursor). Used when the
    /// count guard (ADR 0002 §1) detects backfill below the cursor and we must
    /// re-bootstrap from an empty `since`.
    func reset() throws {
        try? FileManager.default.removeItem(at: logURL)
        try? FileManager.default.removeItem(at: cursorURL)
        knownIds.removeAll()
    }

    // MARK: - File helpers

    private static func readEvents(at url: URL, coder: (encoder: JSONEncoder, decoder: JSONDecoder)) throws -> [SyncEvent] {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8) else { return [] }
        var out: [SyncEvent] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let lineData = line.data(using: .utf8) else { continue }
            // Skip a corrupt line rather than failing the whole load — the log
            // is the source of truth and one bad tail line (e.g. a torn write)
            // shouldn't strand the client. A re-pull will refill it.
            if let event = try? coder.decoder.decode(SyncEvent.self, from: lineData) {
                out.append(event)
            }
        }
        return out
    }

    private static func readIds(at url: URL, coder: (encoder: JSONEncoder, decoder: JSONDecoder)) throws -> Set<String> {
        Set(try readEvents(at: url, coder: coder).map(\.id))
    }

    /// Append bytes to a file, creating it if absent. Uses a file handle so we
    /// don't read-modify-write the whole log on every append.
    private static func appendData(_ data: Data, to url: URL) throws {
        let fm = FileManager.default
        if !fm.fileExists(atPath: url.path) {
            try data.write(to: url, options: .atomic)
            return
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
    }
}
