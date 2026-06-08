import Foundation

@Observable
@MainActor
final class AppStore {
    var client: HubClient?
    var workspaces: [Workspace] = []

    private var _selectedWorkspace: Workspace? = nil
    var selectedWorkspace: Workspace? {
        get { _selectedWorkspace }
        set {
            guard newValue?.id != _selectedWorkspace?.id else { return }
            _selectedWorkspace = newValue
            client?.workspaceId = newValue?.id
            Task { await loadTickets() }
        }
    }

    var tickets: [Ticket] = []
    var isLoading: Bool = false
    var error: String? = nil

    /// Bumped whenever the hub reports a relation add/remove over SSE. Relation
    /// changes don't alter the ticket list, so views that draw relations (the
    /// flow graph) observe this to know when to re-fetch edges.
    var relationsVersion: Int = 0

    // MARK: - Connectivity (SCP-93)
    //
    // The monitor is started lazily on first connect — there's no point
    // running NWPathMonitor on the ConnectionView before the user has even
    // picked a hub, and tests instantiate AppStore() without networking.
    let netMonitor = NetworkPathMonitor()

    /// Live network reachability. Surfaced for the offline banner and
    /// gates writes in the methods below so they fail fast instead of
    /// timing out on URLSession.
    var isOnline: Bool { netMonitor.isOnline }

    // MARK: - Connection

    func connect(to url: URL, token: String? = nil, caFingerprint: String? = nil, session: URLSession? = nil) async {
        let hub = HubClient(
            baseURL: url,
            workspaceId: selectedWorkspace?.id,
            token: token,
            caFingerprint: caFingerprint,
            session: session
        )
        client = hub
        // Start watching the network path now that we actually have a hub
        // to talk to. The transition handler refreshes state when we come
        // back online so any writes that happened on the hub during the
        // outage don't sit stale on screen until the next manual refresh.
        netMonitor.onTransition = { [weak self] online in
            guard let self, online else { return }
            Task { await self.loadTickets() }
        }
        netMonitor.start()
        await loadWorkspaces()
    }

    // MARK: - Workspaces

    func loadWorkspaces() async {
        guard let client else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let list: [Workspace] = try await client.get("/api/workspaces")
            workspaces = list
            if let current = selectedWorkspace,
               let refreshed = list.first(where: { $0.id == current.id }) {
                _selectedWorkspace = refreshed
            } else if selectedWorkspace == nil, let first = list.first {
                selectedWorkspace = first
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: - Tickets

    func loadTickets() async {
        guard let client, selectedWorkspace != nil else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            // Workspace ID is injected automatically by HubClient.url(for:).
            let list: [Ticket] = try await client.get("/api/tickets")
            tickets = list
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Full-text search across every ticket field and comment bodies, ranked
    /// by relevance on the hub (FTS5). Returns [] for an empty query. A genuine
    /// failure (offline, auth, 5xx) surfaces via `error` so it's not mistaken
    /// for "no matches"; a cancelled request (the debounce superseding this one
    /// on the next keystroke) is silent. The workspace is injected by
    /// `HubClient.url(for:)`.
    func search(_ query: String) async -> [Ticket] {
        guard let client else { return [] }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        do {
            return try await client.get("/api/tickets/search", query: [URLQueryItem(name: "q", value: q)])
        } catch is CancellationError {
            return []
        } catch let urlError as URLError where urlError.code == .cancelled {
            return []
        } catch {
            self.error = error.localizedDescription
            return []
        }
    }

    func updateTicket(_ id: String, update: TicketUpdate) async throws {
        guard let client else { return }
        // Fail-fast on offline so the user sees the real reason instead of
        // a long URLSession timeout. The SSE reconnect path will refresh us
        // when we're back online.
        guard isOnline else { throw HubClientError.offline }
        let bodyData = try update.jsonData()
        let updated: Ticket = try await client.patchRaw("/api/tickets/\(id)", bodyData: bodyData)
        if let idx = tickets.firstIndex(where: { $0.id == id }) {
            tickets[idx] = updated
        }
    }

    func createTicket(_ create: CreateTicket) async throws -> Ticket {
        guard let client else {
            throw HubClientError.noData
        }
        guard isOnline else { throw HubClientError.offline }
        let ticket: Ticket = try await client.post("/api/tickets", body: create)
        tickets.append(ticket)
        return ticket
    }

    func deleteTicket(_ id: String) async throws {
        guard let client else { return }
        guard isOnline else { throw HubClientError.offline }
        try await client.delete("/api/tickets/\(id)")
        tickets.removeAll { $0.id == id }
    }

    // MARK: - Relations (SCP — flow graph)

    /// Fetches cross-ticket relations for the given ticket ids concurrently and
    /// returns a deduped set of directed edges for the flow graph.
    ///
    /// There's no bulk relations endpoint, so this fans out one request per
    /// ticket. It's best-effort: a ticket whose request fails simply contributes
    /// no edges rather than failing the whole load.
    func loadRelationEdges(for ids: [String]) async -> [RelationEdge] {
        guard let client else { return [] }
        var relationsByTicket: [String: [TicketRelation]] = [:]
        // Fetch sequentially. The previous withTaskGroup fan-out captured the
        // non-Sendable `HubClient` into N concurrent @Sendable tasks — a Swift-6
        // strict-concurrency violation and a real concurrent-use-of-one-client
        // data race (SCP-104). Serializing removes both; relation fan-out per
        // ticket is small, so the latency cost is negligible. (To restore
        // concurrency later, make HubClient Sendable / an actor first.)
        for id in ids {
            let relations: [TicketRelation] =
                (try? await client.get("/api/tickets/\(id)/relations")) ?? []
            if !relations.isEmpty { relationsByTicket[id] = relations }
        }
        return RelationEdge.dedupe(from: relationsByTicket)
    }

    func loadHistory(before: String? = nil) async throws -> HistoryResponse {
        guard let client else { throw HubClientError.noData }
        var path = "/api/history"
        if let before {
            path += "?before=\(before)"
        }
        return try await client.get(path)
    }
}
