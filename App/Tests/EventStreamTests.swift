import XCTest
@testable import Scope

final class EventStreamTests: XCTestCase {

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
