import Foundation

enum TicketStatus: String, Codable, CaseIterable, Identifiable {
    case backlog
    case todo
    case in_progress
    case in_review
    case done
    case cancelled

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .backlog:     "Backlog"
        case .todo:        "To Do"
        case .in_progress: "In Progress"
        case .in_review:   "In Review"
        case .done:        "Done"
        case .cancelled:   "Cancelled"
        }
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
    let projectId: String
    var parentId: String?
    var assignee: String?
    var labels: [String]
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, title, type, status, priority, description, assignee, labels
        case projectId  = "project_id"
        case parentId   = "parent_id"
        case createdAt  = "created_at"
        case updatedAt  = "updated_at"
    }
}

struct CreateTicket: Encodable {
    let projectId: String
    var title: String
    var type: TicketType
    var status: TicketStatus
    var priority: TicketPriority
    var description: String?
    var parentId: String?

    enum CodingKeys: String, CodingKey {
        case title, type, status, priority, description
        case projectId = "project_id"
        case parentId  = "parent_id"
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
