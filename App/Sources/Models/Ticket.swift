import Foundation

struct TicketStatus: RawRepresentable, Codable, Hashable, CaseIterable, Identifiable {
    var rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue
    }

    static let backlog = TicketStatus(rawValue: "backlog")
    static let todo = TicketStatus(rawValue: "todo")
    static let in_progress = TicketStatus(rawValue: "in_progress")
    static let in_review = TicketStatus(rawValue: "in_review")
    static let done = TicketStatus(rawValue: "done")
    static let cancelled = TicketStatus(rawValue: "cancelled")

    static let allCases: [TicketStatus] = [.backlog, .todo, .in_progress, .in_review, .done, .cancelled]

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .backlog:     "Backlog"
        case .todo:        "To Do"
        case .in_progress: "In Progress"
        case .in_review:   "In Review"
        case .done:        "Done"
        case .cancelled:   "Cancelled"
        default:
            rawValue
                .split(separator: "_")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// The kanban flow order — the same left-to-right sequence the web UI
    /// renders. `cancelled` is excluded: it's a manual sideways state, not
    /// part of the forward progression, so swipe actions skip it.
    static let flow: [TicketStatus] = [.backlog, .todo, .in_progress, .in_review, .done]

    /// The next status in the flow, or `nil` if already at `done` (or in
    /// the cancelled sideways state, which has no defined "next").
    var next: TicketStatus? {
        guard let i = Self.flow.firstIndex(of: self), i + 1 < Self.flow.count else { return nil }
        return Self.flow[i + 1]
    }

    /// The previous status in the flow, or `nil` if already at `backlog`
    /// (or in the cancelled sideways state).
    var previous: TicketStatus? {
        guard let i = Self.flow.firstIndex(of: self), i > 0 else { return nil }
        return Self.flow[i - 1]
    }

    func next(in flow: [TicketStatus]) -> TicketStatus? {
        guard let i = flow.firstIndex(of: self), i + 1 < flow.count else { return nil }
        return flow[i + 1]
    }

    func previous(in flow: [TicketStatus]) -> TicketStatus? {
        guard let i = flow.firstIndex(of: self), i > 0 else { return nil }
        return flow[i - 1]
    }
}

struct BoardColumn: Identifiable, Codable, Hashable, Equatable {
    let id: String
    var label: String
    var color: String
    var kind: String
    var order: Double

    var status: TicketStatus { TicketStatus(rawValue: id) }

    static let defaults: [BoardColumn] = [
        BoardColumn(id: "backlog", label: "Backlog", color: "#64748b", kind: "open", order: 10),
        BoardColumn(id: "todo", label: "Todo", color: "#2563eb", kind: "open", order: 20),
        BoardColumn(id: "in_progress", label: "In Progress", color: "#7c3aed", kind: "open", order: 30),
        BoardColumn(id: "in_review", label: "In Review", color: "#ca8a04", kind: "open", order: 40),
        BoardColumn(id: "done", label: "Done", color: "#16a34a", kind: "done", order: 50),
        BoardColumn(id: "cancelled", label: "Cancelled", color: "#6b7280", kind: "cancelled", order: 60),
    ]
}

struct BoardResponse: Decodable, Equatable {
    let columns: [BoardColumn]
    let terminalColumns: [BoardColumn]
    let buckets: [String: [Ticket]]

    enum CodingKeys: String, CodingKey {
        case columns
        case terminalColumns = "terminal_columns"
        case buckets
    }

    var visibleColumns: [BoardColumn] {
        (columns.isEmpty ? BoardColumn.defaults.filter { $0.kind != "cancelled" } : columns)
            .sorted { $0.order == $1.order ? $0.id < $1.id : $0.order < $1.order }
    }

    var allTickets: [Ticket] {
        buckets.values.flatMap { $0 }
    }
}

enum TicketPriority: String, Codable, CaseIterable, Identifiable {
    case low, medium, high, urgent
    var id: String { rawValue }
}

enum TicketType: String, Codable, CaseIterable, Identifiable {
    case story, bug, epic
    var id: String { rawValue }
}

struct Ticket: Identifiable, Codable, Hashable {
    let id: String
    var title: String
    var type: TicketType
    var status: TicketStatus
    var priority: TicketPriority
    var description: String?
    var parentId: String?
    var assignee: String?
    var labels: [String]
    /// Display number (the N in `SCP-N`). The fallback sort key when `rank` is
    /// absent — mirrors the hub's `COALESCE(rank, number)` ordering (SCP-243).
    var number: Int?
    /// User-defined order within a status column. Fractional, so a single drag
    /// reorders one ticket without renumbering the rest. nil until first moved.
    var rank: Double?
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, title, type, status, priority, description, assignee, labels, number, rank
        case parentId   = "parent_id"
        case createdAt  = "created_at"
        case updatedAt  = "updated_at"
    }

    /// The effective ordering key within a column: the fractional rank, or the
    /// display number when never reordered (matches the hub's board order).
    var sortKey: Double { rank ?? Double(number ?? 0) }
}

// MARK: - Relations

/// The cross-ticket relation kinds the hub stores. Every relation is persisted
/// in both directions (e.g. `A blocks B` ⇒ `B blocked_by A`), so the inverse
/// halves below exist purely so a single ticket's relation list is complete.
enum RelationType: String, Codable, Hashable, CaseIterable {
    case blocks
    case blocked_by
    case relates_to
    case duplicates
    case duplicate_of
}

/// One relation as returned by `GET /api/tickets/:id/relations`: the *other*
/// ticket and how this ticket relates to it.
struct TicketRelation: Codable, Hashable {
    let type: RelationType
    let toTicketId: String
    let title: String?
    let status: TicketStatus?

    enum CodingKeys: String, CodingKey {
        case type
        case toTicketId = "to_ticket_id"
        case title
        case status
        // `ticket_type` is also returned but unused here — extra keys are ignored.
    }
}

/// A single directed edge between two tickets, canonicalised for drawing.
///
/// Because the hub stores both directions of every relation, the same logical
/// link surfaces twice when we fetch each ticket's relations. `dedupe` keeps
/// only the "forward" half of directional links and collapses the symmetric
/// `relates_to` pair so each link is drawn exactly once.
struct RelationEdge: Identifiable, Hashable {
    let from: String
    let to: String
    let type: RelationType

    var id: String { "\(from)|\(to)|\(type.rawValue)" }

    static func dedupe(from relationsByTicket: [String: [TicketRelation]]) -> [RelationEdge] {
        var seen = Set<String>()
        var edges: [RelationEdge] = []
        for (fromId, relations) in relationsByTicket {
            for relation in relations {
                let toId = relation.toTicketId
                guard fromId != toId else { continue }
                switch relation.type {
                case .blocked_by, .duplicate_of:
                    // Inverse half — its forward twin is emitted from `toId`.
                    continue
                case .relates_to:
                    // Symmetric: dedupe on the unordered pair.
                    let key = "rel|" + [fromId, toId].sorted().joined(separator: "|")
                    guard seen.insert(key).inserted else { continue }
                    edges.append(RelationEdge(from: fromId, to: toId, type: .relates_to))
                case .blocks, .duplicates:
                    let key = "\(fromId)|\(toId)|\(relation.type.rawValue)"
                    guard seen.insert(key).inserted else { continue }
                    edges.append(RelationEdge(from: fromId, to: toId, type: relation.type))
                }
            }
        }
        return edges
    }
}

struct CreateTicket: Encodable {
    var title: String
    var type: TicketType
    var status: TicketStatus
    var priority: TicketPriority
    var description: String?
    var parentId: String?

    enum CodingKeys: String, CodingKey {
        case title, type, status, priority, description
        case parentId = "parent_id"
    }
}

struct TicketUpdate: Encodable {
    var title: String?       = nil
    var status: TicketStatus? = nil
    var priority: TicketPriority? = nil
    var description: String? = nil
    var assignee: String?    = nil
    var parentId: String?    = nil

    enum CodingKeys: String, CodingKey {
        case title, status, priority, description, assignee
        case parentId = "parent_id"
    }

    /// Produces a JSON `Data` containing only the non-nil fields.
    func jsonData() throws -> Data {
        var dict: [String: Any] = [:]
        if let v = title       { dict["title"]       = v }
        if let v = status      { dict["status"]      = v.rawValue }
        if let v = priority    { dict["priority"]    = v.rawValue }
        if let v = description { dict["description"] = v }
        if let v = assignee    { dict["assignee"]    = v }
        if let v = parentId    { dict["parent_id"]   = v }
        return try JSONSerialization.data(withJSONObject: dict)
    }
}
