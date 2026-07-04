import Foundation

struct HubMeta: Decodable, Equatable {
    let version: String
    let hosted: Bool
    let remote: RemoteBinding?
    let remoteLink: RemoteLink?

    var remoteSyncStatus: RemoteTaskSyncStatus {
        if hosted {
            return .syncing
        }
        if let remote {
            return remote.connected ? .syncing : .offline
        }
        if remoteLink != nil {
            return .linked
        }
        return .notConfigured
    }

    var remoteSyncDescription: String {
        switch remoteSyncStatus {
        case .syncing:
            if hosted {
                return "Hosted"
            }
            return "Syncing to \(remote?.displayName ?? "remote")"
        case .offline:
            return "\(remote?.displayName ?? "Remote") offline"
        case .linked:
            return "Linked, not connected"
        case .notConfigured:
            return "Not configured"
        }
    }
}

struct RemoteBinding: Decodable, Equatable {
    let url: URL
    let project: String
    let connected: Bool
    let role: String?
    let projectName: String?

    var displayName: String {
        if let projectName, !projectName.isEmpty {
            return projectName
        }
        return project
    }
}

struct RemoteLink: Decodable, Equatable {
    let url: URL?
    let project: String?
    let path: String?
}

enum RemoteTaskSyncStatus: Equatable {
    case syncing
    case offline
    case linked
    case notConfigured
}
