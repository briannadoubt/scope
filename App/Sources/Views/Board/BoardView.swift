import SwiftUI

// MARK: - BoardView

struct BoardView: View {

    @Environment(AppStore.self) private var store

    @State private var eventStream: EventStream?
    @State private var showNewTicketSheet: Bool = false
    @State private var selectedTicket: Ticket? = nil

    private var project: Project? { store.selectedProject }

    var body: some View {
        Group {
            if project == nil {
                ContentUnavailableView(
                    "No Project Selected",
                    systemImage: "square.3.layers.3d",
                    description: Text("Select a project from the Projects tab.")
                )
            } else if store.isLoading && store.tickets.isEmpty {
                ProgressView("Loading…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                boardContent
            }
        }
        .navigationTitle(project?.name ?? "Board")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("New", systemImage: "plus") {
                    showNewTicketSheet = true
                }
                .disabled(project == nil)
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
        .task(id: project?.id) {
            guard project != nil else { return }
            await store.loadTickets()
            startEventStream()
        }
        .onDisappear {
            eventStream?.disconnect()
        }
    }

    // MARK: - Board content

    private var boardContent: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 16) {
                ForEach(TicketStatus.allCases) { status in
                    ColumnView(
                        status: status,
                        tickets: store.tickets.filter { $0.status == status }
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

    // MARK: - Event stream

    private func startEventStream() {
        guard let client = store.client else { return }
        eventStream?.disconnect()

        let stream = EventStream(baseURL: client.baseURL)
        let storeRef = store
        stream.onEvent = { event in
            switch event {
            case .ticketCreated(let ticket):
                if !storeRef.tickets.contains(where: { $0.id == ticket.id }) {
                    storeRef.tickets.append(ticket)
                }
            case .ticketUpdated(let ticket):
                if let idx = storeRef.tickets.firstIndex(where: { $0.id == ticket.id }) {
                    storeRef.tickets[idx] = ticket
                } else {
                    storeRef.tickets.append(ticket)
                }
            case .ticketDeleted(let ticketId):
                storeRef.tickets.removeAll { $0.id == ticketId }
            }
        }
        eventStream = stream
        stream.connect(workspaceId: store.selectedWorkspace?.id)
    }
}

// MARK: - Stub: WorkspaceProjectPicker

/// Placeholder — a full picker will be written by another agent.
struct WorkspaceProjectPicker: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Text(store.selectedProject?.key ?? "—")
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(.quaternary, in: Capsule())
    }
}

