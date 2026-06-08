import Foundation

// MARK: - ULID (SCP-135)
//
// Minimal Crockford-base32 ULID generator, matching the format produced by
// `src/ulid.js` (48-bit ms timestamp + 80 bits of randomness, 26 chars). The
// client must mint its own ULIDs for locally-created events so they carry a
// stable identity before the hub ever sees them (ADR 0001 decentralized
// identity). Lexicographic order == time order, which is exactly the cursor's
// requirement.

enum ULID {
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// Generate a ULID for the given instant (defaults to now).
    static func generate(date: Date = Date()) -> String {
        let ms = UInt64(max(0, date.timeIntervalSince1970 * 1000))
        var chars = [Character](repeating: "0", count: 26)

        // 10 chars of 48-bit timestamp (5 bits each, high → low).
        var t = ms
        for i in stride(from: 9, through: 0, by: -1) {
            chars[i] = alphabet[Int(t & 0x1F)]
            t >>= 5
        }
        // 16 chars of randomness (80 bits).
        for i in 10..<26 {
            chars[i] = alphabet[Int.random(in: 0..<32)]
        }
        return String(chars)
    }
}

// MARK: - LocalEvent builder
//
// Constructs validated-shape event envelopes for the locally-created changes the
// iOS app makes. Mirrors `makeEvent` + the payload contracts in
// `src/event-schema.js`. Payload keys are camelCase (verbatim), matching the
// hub — encoded via `SyncWire.coder`, never `HubClient.encoder`.

enum LocalEvent {

    private static let formatVersion = 1

    /// Build an envelope. `actor` is the authenticated principal; `model` is the
    /// optional acting model for "{model} on behalf of {actor}" attribution.
    private static func make(
        kind: String,
        payload: [String: JSONValue],
        actor: String,
        model: String?,
        date: Date = Date()
    ) -> SyncEvent {
        SyncEvent(
            v: formatVersion,
            id: ULID.generate(date: date),
            ts: date,
            actor: actor,
            model: model,
            kind: kind,
            payload: .object(payload)
        )
    }

    /// `ticket.set_field` for a status change — the latency-critical status
    /// claim (ADR 0002 §4). `ticketId` is the ULID identity, not the display id.
    static func statusClaim(
        ticketId: String,
        status: TicketStatus,
        actor: String,
        model: String? = nil
    ) -> SyncEvent {
        make(
            kind: "ticket.set_field",
            payload: [
                "ticketId": .string(ticketId),
                "field": .string("status"),
                "value": .string(status.rawValue),
            ],
            actor: actor,
            model: model
        )
    }

    /// Generic `ticket.set_field` for any single nullable-string/value field
    /// (title, description, priority, assignee, parentId, branch, prUrl).
    static func setField(
        ticketId: String,
        field: String,
        value: JSONValue,
        actor: String,
        model: String? = nil
    ) -> SyncEvent {
        make(
            kind: "ticket.set_field",
            payload: [
                "ticketId": .string(ticketId),
                "field": .string(field),
                "value": value,
            ],
            actor: actor,
            model: model
        )
    }

    /// `ticket.create`. `number`/`keyPrefix` are the *display* attributes the
    /// hub's replay-time resolver may de-collide (triggering a `renumbered`
    /// notice on push); `ticketId` is the stable ULID identity.
    static func createTicket(
        ticketId: String,
        number: Int,
        keyPrefix: String,
        ticketType: TicketType,
        title: String,
        status: TicketStatus,
        priority: TicketPriority,
        parentId: String?,
        labels: [String],
        actor: String,
        model: String? = nil
    ) -> SyncEvent {
        make(
            kind: "ticket.create",
            payload: [
                "ticketId": .string(ticketId),
                "number": .number(Double(number)),
                "keyPrefix": .string(keyPrefix),
                "ticketType": .string(ticketType.rawValue),
                "title": .string(title),
                "status": .string(status.rawValue),
                "priority": .string(priority.rawValue),
                "parentId": parentId.map(JSONValue.string) ?? .null,
                "labels": .array(labels.map(JSONValue.string)),
            ],
            actor: actor,
            model: model
        )
    }

    /// `ticket.delete`.
    static func deleteTicket(
        ticketId: String,
        actor: String,
        model: String? = nil
    ) -> SyncEvent {
        make(
            kind: "ticket.delete",
            payload: ["ticketId": .string(ticketId)],
            actor: actor,
            model: model
        )
    }
}
