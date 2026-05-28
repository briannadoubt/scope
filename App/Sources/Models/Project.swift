import Foundation

struct Project: Identifiable, Codable, Hashable {
    let id: String
    let key: String
    var name: String
    var description: String?
    var overview: String?
    let nextTicketNumber: Int
    let createdAt: Date
    var updatedAt: Date

    enum CodingKeys: String, CodingKey {
        case id, key, name, description, overview
        case nextTicketNumber = "next_ticket_number"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}
