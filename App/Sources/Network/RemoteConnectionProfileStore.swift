import Foundation
import Security

struct SavedHubConnection: Equatable {
    let baseURL: URL
    let token: String?
    let workspaceId: String?
}

protocol RemoteConnectionSecretStoring {
    func saveToken(_ token: String) throws
    func loadToken() throws -> String?
    func clearToken() throws
}

protocol RemoteConnectionProfileStoring {
    func save(_ profile: SavedHubConnection) throws
    func load() throws -> SavedHubConnection?
    func updateWorkspaceId(_ workspaceId: String?) throws
    func clear() throws
}

final class RemoteConnectionProfileStore: RemoteConnectionProfileStoring {
    static let defaultsKey = "scope.savedHubConnection"

    private let defaults: UserDefaults
    private let secretStore: RemoteConnectionSecretStoring

    init(
        defaults: UserDefaults = .standard,
        secretStore: RemoteConnectionSecretStoring = KeychainRemoteConnectionSecretStore()
    ) {
        self.defaults = defaults
        self.secretStore = secretStore
    }

    func save(_ profile: SavedHubConnection) throws {
        let metadata = StoredHubConnection(
            baseURLString: profile.baseURL.absoluteString,
            workspaceId: profile.workspaceId
        )
        defaults.set(try JSONEncoder().encode(metadata), forKey: Self.defaultsKey)
        if let token = profile.token, !token.isEmpty {
            try secretStore.saveToken(token)
        } else {
            try secretStore.clearToken()
        }
    }

    func load() throws -> SavedHubConnection? {
        guard let data = defaults.data(forKey: Self.defaultsKey) else {
            return nil
        }
        let metadata = try JSONDecoder().decode(StoredHubConnection.self, from: data)
        guard let url = URL(string: metadata.baseURLString) else {
            return nil
        }
        return SavedHubConnection(
            baseURL: url,
            token: try secretStore.loadToken(),
            workspaceId: metadata.workspaceId
        )
    }

    func updateWorkspaceId(_ workspaceId: String?) throws {
        guard let current = try load() else { return }
        try save(SavedHubConnection(
            baseURL: current.baseURL,
            token: current.token,
            workspaceId: workspaceId
        ))
    }

    func clear() throws {
        defaults.removeObject(forKey: Self.defaultsKey)
        try secretStore.clearToken()
    }
}

private struct StoredHubConnection: Codable {
    let baseURLString: String
    let workspaceId: String?
}

final class KeychainRemoteConnectionSecretStore: RemoteConnectionSecretStoring {
    private let service = "com.briannadoubt.scope.remote"
    private let account = "hosted-hub-token"

    func saveToken(_ token: String) throws {
        let data = Data(token.utf8)
        let query = baseQuery
        let attributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData] = data
            addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(addStatus)
            }
            return
        }
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    func loadToken() throws -> String? {
        var query = baseQuery
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
        guard let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw KeychainError.badData
        }
        return token
    }

    func clearToken() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private var baseQuery: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
    }
}
