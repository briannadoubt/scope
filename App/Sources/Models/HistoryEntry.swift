import Foundation

struct HistoryEntry: Identifiable, Codable {
    let id: Int
    let ticketId: String
    let ticketTitle: String?
    let field: String
    let oldValue: String?
    let newValue: String?
    let changedBy: String?
    let changedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, field
        case ticketId    = "ticket_id"
        case ticketTitle = "ticket_title"
        case oldValue    = "old_value"
        case newValue    = "new_value"
        case changedBy   = "changed_by"
        case changedAt   = "changed_at"
    }
}

struct HistoryResponse: Codable {
    let entries: [HistoryEntry]
    let limit: Int
    let before: String?
}
