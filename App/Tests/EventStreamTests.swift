import XCTest
@testable import Scope

final class EventStreamTests: XCTestCase {
    func testRemoteConnectionProfileStoresTokenOutsideDefaults() throws {
        let suiteName = "RemoteConnectionProfile-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let secrets = InMemoryConnectionSecretStore()
        let profiles = RemoteConnectionProfileStore(defaults: defaults, secretStore: secrets)
        let profile = SavedHubConnection(
            baseURL: URL(string: "https://scope.example.test")!,
            token: "sk_mobile_secret",
            workspaceId: "tenant_2"
        )

        try profiles.save(profile)

        let rawDefaults = String(
            data: defaults.data(forKey: RemoteConnectionProfileStore.defaultsKey) ?? Data(),
            encoding: .utf8
        ) ?? ""
        XCTAssertFalse(rawDefaults.contains("sk_mobile_secret"))
        XCTAssertEqual(try profiles.load(), profile)

        try profiles.updateWorkspaceId("tenant_3")
        XCTAssertEqual(try profiles.load()?.workspaceId, "tenant_3")

        try profiles.clear()
        XCTAssertNil(try profiles.load())
        XCTAssertNil(secrets.token)
    }

    @MainActor
    func testAppStoreRestoresSavedHostedRemoteConnection() async throws {
        let suiteName = "RemoteRestore-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let profiles = RemoteConnectionProfileStore(
            defaults: defaults,
            secretStore: InMemoryConnectionSecretStore()
        )
        try profiles.save(SavedHubConnection(
            baseURL: URL(string: "https://scope.example.test")!,
            token: "sk_mobile_secret",
            workspaceId: "tenant_2"
        ))

        StubURLProtocol.requestedKeys = []
        StubURLProtocol.responses = [
            "GET /api/meta": """
            {
              "version": "0.8.2",
              "hosted": true,
              "remote": null,
              "remoteLink": null
            }
            """,
            "GET /api/workspaces": """
            [
              {
                "id": "tenant_1",
                "scope_dir": null,
                "label": "Other",
                "key": "OT",
                "name": "Other",
                "description": "",
                "overview": ""
              },
              {
                "id": "tenant_2",
                "scope_dir": null,
                "label": "Scope",
                "key": "SCP",
                "name": "Scope",
                "description": "",
                "overview": ""
              }
            ]
            """,
            "GET /api/tickets?workspace=tenant_2": "[]",
        ]
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        let session = URLSession(configuration: configuration)

        let store = AppStore(connectionStore: profiles)
        await store.restoreSavedConnection(session: session, startNetworkMonitor: false)

        XCTAssertEqual(store.client?.baseURL, URL(string: "https://scope.example.test")!)
        XCTAssertEqual(store.client?.token, "sk_mobile_secret")
        XCTAssertEqual(store.hubMeta?.remoteSyncStatus, .syncing)
        XCTAssertEqual(store.selectedWorkspace?.id, "tenant_2")
        XCTAssertTrue(StubURLProtocol.requestedKeys.contains("GET /api/meta"))
        XCTAssertTrue(StubURLProtocol.requestedKeys.contains("GET /api/workspaces"))
        XCTAssertFalse(StubURLProtocol.requestedKeys.contains { $0.hasPrefix("GET /api/meta?") })
        XCTAssertFalse(StubURLProtocol.requestedKeys.contains { $0.hasPrefix("GET /api/workspaces?") })
    }

    @MainActor
    func testHubMetaRemoteTaskSyncStatusDecodesUnconfiguredAndConnectedStates() throws {
        let localOnly = try HubClient.decoder.decode(HubMeta.self, from: Data("""
        {
          "version": "0.8.2",
          "hosted": false,
          "remote": null,
          "remoteLink": null
        }
        """.utf8))

        XCTAssertEqual(localOnly.remoteSyncStatus, .notConfigured)
        XCTAssertEqual(localOnly.remoteSyncDescription, "Not configured")

        let bound = try HubClient.decoder.decode(HubMeta.self, from: Data("""
        {
          "version": "0.8.2",
          "hosted": false,
          "remote": {
            "url": "https://scope.example.test",
            "project": "tenant_123",
            "connected": true,
            "role": "owner",
            "projectName": "Scope"
          },
          "remoteLink": {
            "url": "https://scope.example.test",
            "project": "tenant_123",
            "path": ".scope/remote.json"
          }
        }
        """.utf8))

        XCTAssertEqual(bound.remoteSyncStatus, .syncing)
        XCTAssertEqual(bound.remoteSyncDescription, "Syncing to Scope")
    }

    func testRemoteSyncAppliedFrameRequestsTicketRefresh() {
        let frame = """
event: change
data: {"type":"sync.applied","workspace":"SCP","applied":1}

"""

        XCTAssertEqual(SSEFrameParser.event(from: frame), .ticketsChanged)
    }

    func testRemotePulledFrameRequestsTicketRefresh() {
        let frame = """
event: change
data: {"type":"remote.pulled","workspace":"SCP","pulled":2}

"""

        XCTAssertEqual(SSEFrameParser.event(from: frame), .ticketsChanged)
    }

    func testGossipPulledFrameRequestsTicketRefresh() {
        let frame = """
event: change
data: {"type":"gossip.pulled","workspace":"SCP","pulled":3}

"""

        XCTAssertEqual(SSEFrameParser.event(from: frame), .ticketsChanged)
    }

    func testTicketUpdatedEnvelopeWithoutEmbeddedTicketRequestsRefresh() {
        let frame = """
event: change
data: {"type":"ticket.updated","id":"SCP-265","title":"remote update","field":"status"}

"""

        XCTAssertEqual(SSEFrameParser.event(from: frame), .ticketsChanged)
    }

    func testRelationFrameRequestsRelationRefresh() {
        let frame = """
event: change
data: {"type":"relation.added","from":"SCP-1","to":"SCP-2"}

"""

        XCTAssertEqual(SSEFrameParser.event(from: frame), .relationsChanged)
    }

    func testPresenceFrameDoesNotRefreshTickets() {
        let frame = """
event: change
data: {"type":"presence","workspace":"SCP"}

"""

        XCTAssertNil(SSEFrameParser.event(from: frame))
    }

    @MainActor
    func testHubClientEventStreamCarriesBearerToken() {
        let client = HubClient(
            baseURL: URL(string: "https://scope.example.test")!,
            workspaceId: "SCP",
            token: "test-token",
            session: URLSession(configuration: .ephemeral)
        )

        let request = client.makeEventStream().request(workspaceId: client.workspaceId)

        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "text/event-stream")
        XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == "workspace" })?
            .value, "SCP")
    }
}

private final class InMemoryConnectionSecretStore: RemoteConnectionSecretStoring {
    var token: String?

    func saveToken(_ token: String) throws {
        self.token = token
    }

    func loadToken() throws -> String? {
        token
    }

    func clearToken() throws {
        token = nil
    }
}

private final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var responses: [String: String] = [:]
    nonisolated(unsafe) static var requestedKeys: [String] = []

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        let url = request.url!
        let query = url.query.map { "?\($0)" } ?? ""
        let key = "\(method) \(url.path)\(query)"
        Self.requestedKeys.append(key)
        let body = Self.responses[key] ?? "{}"
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
