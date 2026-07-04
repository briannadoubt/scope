import XCTest
@testable import Scope

final class EventStreamTests: XCTestCase {
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
