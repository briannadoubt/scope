import Foundation

struct Workspace: Identifiable, Codable, Hashable {
    let id: String
    let label: String
    let scopeDir: String?
    /// Ticket key prefix, e.g. "SCP". Optional — some workspace DBs may be
    /// malformed or not yet migrated.
    var key: String?
    /// Human-readable workspace name. Optional for the same reason.
    var name: String?
    /// Short one-line blurb.
    var description: String?
    /// Long-form markdown overview.
    var overview: String?

    enum CodingKeys: String, CodingKey {
        case id, label, key, name, description, overview
        case scopeDir = "scope_dir"
    }

    /// The best display name: prefer `name`, fall back to `label`.
    var displayName: String {
        if let name, !name.isEmpty { return name }
        return label
    }
}
