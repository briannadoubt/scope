import SwiftUI

/// Sheet for creating a new ticket in the currently-selected workspace.
///
/// Present this as a `.sheet`.  The view dismisses itself after a successful
/// save or when the user taps **Cancel**.
///
/// ```swift
/// .sheet(isPresented: $showNewTicket) {
///     NewTicketView()
/// }
/// ```
struct NewTicketView: View {

    // MARK: Dependencies

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    // MARK: Form state

    @State private var title: String = ""
    @State private var type: TicketType = .story
    @State private var status: TicketStatus = .backlog
    @State private var priority: TicketPriority = .medium
    @State private var description: String = ""

    // MARK: Async state

    @State private var isSaving: Bool = false
    @State private var saveError: String?

    // MARK: Derived

    private var canSave: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty && !isSaving
    }

    // MARK: Body

    var body: some View {
        NavigationStack {
            Form {
                // ── Error banner ──────────────────────────────────────
                if let error = saveError {
                    Section {
                        HStack(spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                            Text(error)
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                            Spacer()
                            Button {
                                saveError = nil
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .listRowBackground(Color.red.opacity(0.08))
                }

                // ── Title ─────────────────────────────────────────────
                Section {
                    TextField("Ticket title", text: $title)
                        .submitLabel(.done)
                } header: {
                    Text("Title")
                } footer: {
                    if title.trimmingCharacters(in: .whitespaces).isEmpty {
                        Text("Required")
                            .foregroundStyle(.red)
                    }
                }

                // ── Metadata ──────────────────────────────────────────
                Section("Details") {
                    Picker("Type", selection: $type) {
                        ForEach(TicketType.allCases) { t in
                            Text(t.rawValue.capitalized).tag(t)
                        }
                    }
                    .pickerStyle(.menu)

                    Picker("Status", selection: $status) {
                        ForEach(store.boardColumns) { column in
                            Text(column.label).tag(column.status)
                        }
                    }
                    .pickerStyle(.menu)

                    Picker("Priority", selection: $priority) {
                        ForEach(TicketPriority.allCases) { p in
                            Text(p.rawValue.capitalized).tag(p)
                        }
                    }
                    .pickerStyle(.menu)
                }

                // ── Description ───────────────────────────────────────
                Section("Description") {
                    TextEditor(text: $description)
                        .frame(minHeight: 100)
                }
            }
            .navigationTitle("New Ticket")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .disabled(isSaving)
            .overlay {
                if isSaving {
                    savingOverlay
                }
            }
            .onAppear {
                if !store.boardColumns.contains(where: { $0.status == status }) {
                    status = firstBoardStatus
                }
            }
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("Save") { saveTicket() }
                .disabled(!canSave)
                .bold()
        }
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { dismiss() }
                .disabled(isSaving)
        }
    }

    // MARK: Saving overlay

    private var savingOverlay: some View {
        ZStack {
            Color.black.opacity(0.18)
                .ignoresSafeArea()
            VStack(spacing: 12) {
                ProgressView()
                    .controlSize(.large)
                Text("Creating…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(28)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }

    // MARK: Action

    private func saveTicket() {
        guard store.selectedWorkspace != nil else {
            saveError = "No workspace selected."
            return
        }

        let trimmedTitle = title.trimmingCharacters(in: .whitespaces)
        guard !trimmedTitle.isEmpty else { return }

        let create = CreateTicket(
            title:       trimmedTitle,
            type:        type,
            status:      status,
            priority:    priority,
            description: description.isEmpty ? nil : description
        )

        isSaving  = true
        saveError = nil

        Task {
            defer { isSaving = false }
            do {
                _ = try await store.createTicket(create)
                dismiss()
            } catch {
                saveError = error.localizedDescription
            }
        }
    }
}

private extension NewTicketView {
    var firstBoardStatus: TicketStatus {
        store.boardColumns.first?.status ?? .backlog
    }
}

// MARK: - Preview

#Preview("New Ticket Sheet") {
    let store = AppStore()
    store.workspaces = [
        Workspace(
            id: "ws-1",
            label: "scope",
            scopeDir: "/repo/.scope",
            key: "SCP",
            name: "Scope",
            description: nil,
            overview: nil
        )
    ]
    store.selectedWorkspace = store.workspaces.first
    return NewTicketView()
        .environment(store)
}

#Preview("No workspace selected") {
    NewTicketView()
        .environment(AppStore())
}
