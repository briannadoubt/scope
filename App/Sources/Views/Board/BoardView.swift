import SwiftUI

// MARK: - BoardView

struct BoardView: View {

    @Environment(AppStore.self) private var store

    @State private var eventStream: EventStream?
    @State private var showNewTicketSheet: Bool = false
    @State private var selectedTicket: Ticket? = nil

    // MARK: Search
    @State private var searchText: String = ""
    @State private var searchResults: [Ticket] = []
    @State private var isSearching: Bool = false

    private var trimmedSearch: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var workspace: Workspace? { store.selectedWorkspace }

    private var navigationTitle: String {
        guard let ws = workspace else { return "Board" }
        if let key = ws.key, !key.isEmpty {
            return "\(key) · \(ws.displayName)"
        }
        return ws.displayName
    }

    var body: some View {
        Group {
            if workspace == nil {
                ContentUnavailableView(
                    "No Workspace Selected",
                    systemImage: "square.3.layers.3d",
                    description: Text("Select a workspace from the menu.")
                )
            } else if !trimmedSearch.isEmpty {
                searchResults_view
            } else if store.isLoading && store.tickets.isEmpty {
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.tickets.isEmpty {
                BoardEmptyStateView(workspace: workspace) {
                    showNewTicketSheet = true
                }
            } else {
                boardContent
            }
        }
        .navigationTitle(navigationTitle)
        .searchable(
            text: $searchText,
            placement: .navigationBarDrawer(displayMode: .automatic),
            prompt: "Search tickets, comments, @assignee…"
        )
        .task(id: searchText) { await runSearch() }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("New", systemImage: "plus") {
                    showNewTicketSheet = true
                }
                .disabled(workspace == nil)
            }
        }
        .sheet(isPresented: $showNewTicketSheet) {
            NewTicketView()
        }
        .sheet(item: $selectedTicket) { ticket in
            NavigationStack {
                TicketDetailView(ticket: ticket)
            }
        }
        .task(id: workspace?.id) {
            guard workspace != nil else { return }
            await store.loadTickets()
            startEventStream()
        }
        .onChange(of: workspace?.id) {
            // Search state is keyed on searchText, not workspace, so without
            // this a switch would leave the previous workspace's results (and
            // query) on screen. Reset so the board shows the new workspace.
            searchText = ""
            searchResults = []
            isSearching = false
        }
        .onChange(of: store.tickets) {
            // Keep visible results in step with live SSE updates: drop any that
            // were deleted on the hub and refresh fields (status/title/…) of the
            // rest from the canonical list. (Newly-matching tickets need a fresh
            // query — handled on the next keystroke.)
            guard !trimmedSearch.isEmpty, !searchResults.isEmpty else { return }
            let byId = Dictionary(store.tickets.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            searchResults = searchResults.compactMap { byId[$0.id] }
        }
        .onDisappear {
            eventStream?.disconnect()
        }
    }

    // MARK: - Board content

    /// Tickets in a column, in the user-defined order. Sorts by fractional rank
    /// (falling back to display number), matching the hub's board ordering
    /// `COALESCE(rank, number)` so web and iOS agree (SCP-243). Extracted from
    /// `body` to keep the SwiftUI view expression cheap to type-check.
    private func tickets(in status: TicketStatus) -> [Ticket] {
        store.tickets
            .filter { $0.status == status }
            .sorted {
                $0.sortKey != $1.sortKey
                    ? $0.sortKey < $1.sortKey
                    : ($0.number ?? 0) < ($1.number ?? 0)
            }
    }

    private var boardContent: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 16) {
                ForEach(store.boardColumns) { column in
                    ColumnView(
                        column: column,
                        tickets: tickets(in: column.status),
                        flow: store.boardColumns.map(\.status)
                    ) { ticket in
                        selectedTicket = ticket
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .scrollClipDisabled()
    }

    // MARK: - Search

    @ViewBuilder
    private var searchResults_view: some View {
        if isSearching && searchResults.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if searchResults.isEmpty {
            ContentUnavailableView.search(text: trimmedSearch)
        } else {
            List {
                ForEach(searchResults) { ticket in
                    Button {
                        selectedTicket = ticket
                    } label: {
                        SearchResultRow(ticket: ticket)
                    }
                    .buttonStyle(.plain)
                }
                // Surface the server-side cap so a >50-match query doesn't look complete.
                if searchResults.count >= Self.searchPageSize {
                    Text("Showing the first \(Self.searchPageSize) matches — refine your search to narrow.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
        }
    }

    /// Server default page size for search; mirrored here to flag truncation.
    private static let searchPageSize = 50

    /// Debounced search. `.task(id: searchText)` cancels and restarts this on
    /// every keystroke, so the sleep below throttles requests to the hub while
    /// the user is still typing; only the final pause actually fires.
    private func runSearch() async {
        let q = trimmedSearch
        guard !q.isEmpty else {
            searchResults = []
            isSearching = false
            return
        }
        // Flip the spinner on *before* the debounce so the first keystroke
        // shows a loading state instead of a brief "No Results" flash.
        isSearching = true
        try? await Task.sleep(for: .milliseconds(250))
        if Task.isCancelled { return }
        let results = await store.search(q)
        // Cancellation alone doesn't serialize responses, and store.search()
        // swallows the cancellation error — so also confirm the query is still
        // current before publishing, lest a slow older response clobber a newer.
        if Task.isCancelled || q != trimmedSearch { return }
        searchResults = results
        isSearching = false
    }

    // MARK: - Event stream

    private func startEventStream() {
        guard let client = store.client else { return }
        eventStream?.disconnect()

        let stream = client.makeEventStream()
        let storeRef = store
        stream.onEvent = { event in
            switch event {
            case .connected, .ticketsChanged:
                Task { await storeRef.loadTickets() }
            case .relationsChanged:
                break // the board doesn't draw relations
            }
        }
        eventStream = stream
        stream.connect(workspaceId: client.workspaceId)
    }
}

// MARK: - SearchResultRow

/// One row in the search results list. Surfaces the fields a query can match —
/// key, type, priority, status, assignee, labels — so it's obvious why a ticket
/// came back. Tapping the row opens the full TicketDetailView.
private struct SearchResultRow: View {
    let ticket: Ticket

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                TicketBadges(ticket: ticket)

                Spacer(minLength: 4)

                Text(ticket.id)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }

            Text(ticket.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 8) {
                Text(ticket.status.displayName)
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                if let assignee = ticket.assignee, !assignee.isEmpty {
                    Text("@\(assignee)")
                        .font(.caption2)
                        .foregroundStyle(.blue)
                }

                ForEach(ticket.labels, id: \.self) { label in
                    Text(label)
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}
