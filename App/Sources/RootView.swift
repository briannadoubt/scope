import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        ZStack(alignment: .top) {
            if store.client == nil {
                ConnectionView()
            } else {
                MainTabView()
            }
            // Offline banner (SCP-93). Lives at the root so it appears over
            // every connected screen — Board, Overview, History, Settings —
            // without each having to opt in. Drops off-screen when the
            // network returns; AppStore refreshes tickets on that edge.
            VStack { OfflineBanner() ; Spacer(minLength: 0) }
                .animation(.spring(response: 0.34, dampingFraction: 0.85),
                           value: store.isOnline)
                .allowsHitTesting(false)
        }
    }
}

// MARK: - Main tab container

private struct MainTabView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        TabView {
            Tab("Board", systemImage: "square.3.layers.3d") {
                NavigationStack {
                    BoardView()
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                workspaceMenu
                            }
                        }
                }
            }
            Tab("Overview", systemImage: "doc.text") {
                NavigationStack { WorkspaceOverviewView() }
            }
            Tab("History", systemImage: "clock") {
                NavigationStack { HistoryView() }
            }
            Tab("Settings", systemImage: "gear") {
                NavigationStack { SettingsView() }
            }
        }
        .tabViewStyle(.sidebarAdaptable)
    }

    @ViewBuilder
    private var workspaceMenu: some View {
        Menu {
            Section("Workspaces") {
                ForEach(store.workspaces) { ws in
                    Button {
                        store.selectedWorkspace = ws
                    } label: {
                        if store.selectedWorkspace?.id == ws.id {
                            Label(ws.displayName, systemImage: "checkmark")
                        } else {
                            Text(ws.displayName)
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                if let key = store.selectedWorkspace?.key, !key.isEmpty {
                    Text(key)
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                Text(store.selectedWorkspace?.displayName ?? "Workspace")
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
            }
        }
    }
}

// MARK: - Workspace overview

struct WorkspaceOverviewView: View {
    @Environment(AppStore.self) private var store
    @State private var showSwitcher = false

    var body: some View {
        Group {
            if let ws = store.selectedWorkspace {
                Form {
                    Section {
                        Button {
                            showSwitcher = true
                        } label: {
                            Label("Switch workspace", systemImage: "arrow.left.arrow.right")
                        }
                    }

                    Section("Identifier") {
                        if let key = ws.key, !key.isEmpty {
                            metadataRow(label: "Key", value: key)
                        }
                        metadataRow(label: "Name", value: ws.displayName)
                        metadataRow(label: "Scope Dir", value: ws.scopeDir)
                    }

                    if let desc = ws.description, !desc.isEmpty {
                        Section("Description") {
                            Text(desc)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    if let overview = ws.overview, !overview.isEmpty {
                        Section("Overview") {
                            // Render as markdown when possible; fall back to plain text.
                            if let attributed = try? AttributedString(
                                markdown: overview,
                                options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
                            ) {
                                Text(attributed)
                                    .fixedSize(horizontal: false, vertical: true)
                            } else {
                                Text(overview)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .navigationTitle("Overview")
                .confirmationDialog(
                    "Switch Workspace",
                    isPresented: $showSwitcher,
                    titleVisibility: .visible
                ) {
                    ForEach(store.workspaces) { other in
                        Button(other.displayName) {
                            store.selectedWorkspace = other
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                }
            } else {
                ContentUnavailableView(
                    "No Workspace Selected",
                    systemImage: "folder",
                    description: Text("Select a workspace from the menu.")
                )
                .navigationTitle("Overview")
            }
        }
        .task { await store.loadWorkspaces() }
    }

    private func metadataRow(label: String, value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .multilineTextAlignment(.trailing)
        }
    }
}

// MARK: - History

struct HistoryView: View {
    @Environment(AppStore.self) private var store
    @State private var entries: [HistoryEntry] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let ws = store.selectedWorkspace {
                List(entries) { entry in
                    HistoryEntryRow(entry: entry)
                }
                .navigationTitle("History")
                .overlay {
                    if entries.isEmpty && !isLoading {
                        ContentUnavailableView(
                            "No History",
                            systemImage: "clock",
                            description: Text("No changes recorded yet for \(ws.displayName).")
                        )
                    }
                }
                .task(id: ws.id) {
                    await fetchHistory()
                }
            } else {
                ContentUnavailableView(
                    "No Workspace Selected",
                    systemImage: "clock",
                    description: Text("Select a workspace to view its history.")
                )
                .navigationTitle("History")
            }
        }
    }

    private func fetchHistory() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await store.loadHistory()
            entries = response.entries
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct HistoryEntryRow: View {
    let entry: HistoryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(entry.ticketTitle ?? entry.ticketId)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Text(entry.changedAt, style: .relative)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text("\(entry.field): \(entry.oldValue ?? "—") → \(entry.newValue ?? "—")")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let who = entry.changedBy {
                Text("by \(who)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct SettingsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section("Hub") {
                if let url = store.client?.baseURL {
                    LabeledContent("URL", value: url.absoluteString)
                }
                LabeledContent("Status", value: store.client?.isConnected == true ? "Connected" : "Disconnected")
            }

            Section("Workspace") {
                Picker("Active Workspace", selection: Binding(
                    get: { store.selectedWorkspace },
                    set: { store.selectedWorkspace = $0 }
                )) {
                    Text("None").tag(Optional<Workspace>.none)
                    ForEach(store.workspaces) { ws in
                        Text(ws.displayName).tag(Optional(ws))
                    }
                }
            }

            Section {
                Button("Disconnect", role: .destructive) {
                    store.client = nil
                    store.workspaces = []
                    store.selectedWorkspace = nil
                    store.tickets = []
                }
            }
        }
        .navigationTitle("Settings")
    }
}

#Preview {
    RootView()
        .environment(AppStore())
}
