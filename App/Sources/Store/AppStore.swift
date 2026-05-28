import Foundation

@Observable
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

    func updateTicket(_ id: String, update: TicketUpdate) async throws {
        guard let client else { return }
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
        let ticket: Ticket = try await client.post("/api/tickets", body: create)
        tickets.append(ticket)
        return ticket
    }

    func deleteTicket(_ id: String) async throws {
        guard let client else { return }
        try await client.delete("/api/tickets/\(id)")
        tickets.removeAll { $0.id == id }
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
