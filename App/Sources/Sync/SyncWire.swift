import Foundation

// MARK: - SyncWire (SCP-135)
//
// Codable types for the hub sync protocol (ADR 0002).
//
//   GET  /api/sync/pull?since=<ulid>&limit=N
//        -> { events, cursor, count, more }
//   POST /api/sync/push { events:[...] }
//        -> { accepted, duplicates, renumbered, cursor, count }
//
// IMPORTANT — coding strategy
// ---------------------------
// Event envelopes and their payloads use **camelCase** keys on the wire
// (`ticketId`, `keyPrefix`, `ticketType`, `fromId`, ...) — see
// `src/event-schema.js`. That is the opposite of the rest of the REST API,
// which is snake_case. `HubClient.encoder` is configured with
// `.convertToSnakeCase`, so it MUST NOT be used to encode/decode these types
// or it will corrupt payload keys. `SyncWire.coder` below uses the default
// (verbatim) key strategy and a matching ISO-8601 date strategy.

// MARK: - Event envelope

/// One event-log entry, matching the envelope in `src/event-schema.js`.
///
/// The `payload` is kind-specific and intentionally kept as a type-erased JSON
/// value: the iOS client does not need to interpret every payload shape to act
/// as a replica/transport, and keeping it opaque means a new server-side
/// `kind` never breaks decoding. Helpers below pull out the few fields the
/// engine needs (notably `ticketId` for optimistic apply + renumber rewrite).
struct SyncEvent: Codable, Identifiable, Hashable {
    /// Event-envelope format version (`EVENT_FORMAT_VERSION`, currently 1).
    let v: Int
    /// ULID identity — globally unique, lexicographically time-sortable, and
    /// the cursor's unit. This is the durable key; display ids may change.
    let id: String
    /// ISO-8601 timestamp.
    let ts: Date
    /// The human principal who caused the change.
    let actor: String
    /// Optional acting model (SCP-128). Attribution renders
    /// "{model} on behalf of {actor}".
    let model: String?
    /// One of the closed `EVENT_KINDS` set (e.g. `ticket.create`,
    /// `ticket.set_field`, `relation.add`).
    let kind: String
    /// Kind-specific payload, kept opaque (see type doc).
    let payload: JSONValue

    // The envelope keys are verbatim (v, id, ts, actor, model, kind, payload);
    // no CodingKeys remapping needed under the verbatim coder.
}

extension SyncEvent {
    /// Display attribution string, matching the hub's `formatActor`.
    var attribution: String {
        if let model, !model.isEmpty { return "\(model) on behalf of \(actor)" }
        return actor
    }

    /// The ULID of the ticket this event concerns, if its payload carries one.
    /// Covers `ticket.create` / `ticket.set_field` / `ticket.delete`
    /// (`payload.ticketId`). Relation/comment/workspace events return nil.
    var ticketId: String? {
        payload.object?["ticketId"]?.string
    }
}

// MARK: - Pull

/// Response body of `GET /api/sync/pull`.
struct PullResponse: Codable {
    /// Events with `id > since`, id-sorted (ascending). Replayed canonically by
    /// the client regardless of this send order.
    let events: [SyncEvent]
    /// New ULID high-water mark to persist. May equal the request's `since`
    /// when the page was empty.
    let cursor: String?
    /// Total events in the server log — the backfill/“count guard” (ADR 0002 §1).
    let count: Int
    /// True when more pages remain after `cursor`; the client should pull again.
    let more: Bool
}

// MARK: - Push

/// Request body of `POST /api/sync/push`.
struct PushRequest: Codable {
    let events: [SyncEvent]
}

/// One display-number reassignment notice, matching
/// `resolveDisplayNumbers().renumbered` in `src/identity.js`:
/// `{ ticketId, from, to }`. `ticketId` is the stable ULID identity; `from`/`to`
/// are the *display* numbers (the N in `SCP-N`). The ULID never changes — only
/// the rendered key — so the client rewrites display ids in place.
struct RenumberNotice: Codable, Hashable {
    let ticketId: String
    let from: Int
    let to: Int
}

/// Response body of `POST /api/sync/push`.
///
/// Note: the single-tenant SQLite hub (`src/server.js`) returns `accepted` as
/// an array of **id strings**; the Postgres store (`src/pg/store.js`) returns
/// full event objects. We only need the ids, and decode defensively to accept
/// either shape (see `AcceptedIds`).
struct PushResponse: Codable {
    /// ULIDs newly applied by the server (everything not already in its log).
    let accepted: [String]
    /// ULIDs the server already had — confirmed no-ops (idempotent push).
    let duplicates: [String]
    /// Display-number reassignments triggered by this push (usually empty).
    let renumbered: [RenumberNotice]
    /// New server high-water cursor after the union.
    let cursor: String?
    /// Total events in the server log after the union.
    let count: Int

    enum CodingKeys: String, CodingKey {
        case accepted, duplicates, renumbered, cursor, count
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.accepted = try c.decode(AcceptedIds.self, forKey: .accepted).ids
        self.duplicates = try c.decodeIfPresent([String].self, forKey: .duplicates) ?? []
        self.renumbered = try c.decodeIfPresent([RenumberNotice].self, forKey: .renumbered) ?? []
        self.cursor = try c.decodeIfPresent(String.self, forKey: .cursor)
        self.count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(accepted, forKey: .accepted)
        try c.encode(duplicates, forKey: .duplicates)
        try c.encode(renumbered, forKey: .renumbered)
        try c.encodeIfPresent(cursor, forKey: .cursor)
        try c.encode(count, forKey: .count)
    }
}

/// Decodes `accepted` whether the server sent `[String]` (SQLite hub) or
/// `[{id,...}]` (Postgres store), normalising to plain ULID strings.
private struct AcceptedIds: Decodable {
    let ids: [String]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [String] = []
        while !container.isAtEnd {
            if let s = try? container.decode(String.self) {
                out.append(s)
            } else {
                let obj = try container.decode(IdOnly.self)
                out.append(obj.id)
            }
        }
        self.ids = out
    }

    private struct IdOnly: Decodable { let id: String }
}

// MARK: - Coder

extension SyncWire {
    /// JSON coder for the sync wire format. Verbatim keys (NOT snake_case) and
    /// an ISO-8601 date strategy matching `HubClient`'s (fractional seconds,
    /// falling back to whole seconds on decode).
    static let coder: (encoder: JSONEncoder, decoder: JSONDecoder) = {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]

        let decoder = JSONDecoder()
        // Verbatim keys — do NOT convert from snake_case.
        decoder.dateDecodingStrategy = .custom { dec in
            let container = try dec.singleValueContainer()
            let str = try container.decode(String.self)
            if let d = fractional.date(from: str) { return d }
            if let d = plain.date(from: str) { return d }
            throw DecodingError.dataCorruptedError(
                in: container, debugDescription: "Cannot parse date: \(str)")
        }

        let encoder = JSONEncoder()
        // Verbatim keys — do NOT convert to snake_case.
        encoder.dateEncodingStrategy = .custom { date, enc in
            var container = enc.singleValueContainer()
            try container.encode(fractional.string(from: date))
        }
        return (encoder, decoder)
    }()
}

/// Namespace for sync-wire statics (the coder lives in the extension above).
enum SyncWire {}
