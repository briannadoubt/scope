import Foundation

struct Workspace: Identifiable, Codable, Hashable {
    let id: String
    let label: String
    let scopeDir: String

    enum CodingKeys: String, CodingKey {
        case id, label
        case scopeDir = "scope_dir"
    }
}
