import SwiftUI

struct RootView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if store.client == nil {
            ConnectionView()
        } else {
            MainTabView()
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
                                workspaceProjectMenu
                            }
                        }
                }
            }
            Tab("Projects", systemImage: "folder") {
                NavigationStack { ProjectOverviewView() }
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

    // NOTE: PairingView integration lives in ConnectionView.swift / HubRowView.swift.
    // HubRowView should offer a long-press or swipe action that presents
    // PairingView(hub:) as a sheet. This file does not own those views.

    @ViewBuilder
    private var workspaceProjectMenu: some View {
        Menu {
            // Project selection
            Section("Projects") {
                Button {
                    store.selectedProject = nil
                } label: {
                    if store.selectedProject == nil {
                        Label("All Projects", systemImage: "checkmark")
                    } else {
                        Text("All Projects")
                    }
                }

                ForEach(store.projects) { project in
                    Button {
                        Task { await store.selectProject(project) }
                    } label: {
                        if store.selectedProject?.id == project.id {
                            Label(project.name, systemImage: "checkmark")
                        } else {
                            Text(project.name)
                        }
                    }
                }
            }

            // Workspace selection (only shown when there are multiple workspaces)
            if store.workspaces.count > 1 {
                Section("Workspaces") {
                    ForEach(store.workspaces) { ws in
                        Button {
                            store.selectedWorkspace = ws
                        } label: {
                            if store.selectedWorkspace?.id == ws.id {
                                Label(ws.label, systemImage: "checkmark")
                            } else {
                                Text(ws.label)
                            }
                        }
                    }
                }
            }
        } label: {
            Label(
                store.selectedProject?.name ?? "All Projects",
                systemImage: "chevron.up.chevron.down"
            )
        }
    }
}

struct ProjectOverviewView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        List(store.projects) { project in
            Button {
                Task { await store.selectProject(project) }
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(project.name)
                        .font(.headline)
                    Text(project.key)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
        }
        .navigationTitle("Projects")
        .overlay {
            if store.projects.isEmpty && !store.isLoading {
                ContentUnavailableView(
                    "No Projects",
                    systemImage: "folder",
                    description: Text("Create a project from the Scope CLI.")
                )
            }
        }
        .task { await store.loadProjects() }
    }
}

struct HistoryView: View {
    @Environment(AppStore.self) private var store
    @State private var entries: [HistoryEntry] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let project = store.selectedProject {
                List(entries) { entry in
                    HistoryEntryRow(entry: entry)
                }
                .navigationTitle("History")
                .overlay {
                    if entries.isEmpty && !isLoading {
                        ContentUnavailableView(
                            "No History",
                            systemImage: "clock",
                            description: Text("No changes recorded yet for \(project.name).")
                        )
                    }
                }
                .task(id: project.id) {
                    await fetchHistory(projectId: project.id)
                }
            } else {
                ContentUnavailableView(
                    "No Project Selected",
                    systemImage: "clock",
                    description: Text("Select a project to view its history.")
                )
                .navigationTitle("History")
            }
        }
    }

    private func fetchHistory(projectId: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response = try await store.loadHistory(project: projectId)
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
                        Text(ws.label).tag(Optional(ws))
                    }
                }
            }

            Section {
                Button("Disconnect", role: .destructive) {
                    store.client = nil
                    store.workspaces = []
                    store.selectedWorkspace = nil
                    store.projects = []
                    store.selectedProject = nil
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
