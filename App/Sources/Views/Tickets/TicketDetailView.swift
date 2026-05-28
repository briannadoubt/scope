import SwiftUI

/// Full detail and edit view for a single `Ticket`.
///
/// Displayed as a pushed `NavigationStack` destination.  Tapping **Edit** in
/// the toolbar switches to an in-place edit mode; **Save** commits changes via
/// `AppStore.updateTicket`; **Cancel** restores the original values.
struct TicketDetailView: View {

    // MARK: Dependencies

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    // MARK: Input

    /// The ticket being displayed.  The view resolves the live copy from the
    /// store on save so the list stays in sync, but keeps its own draft while
    /// editing to allow a clean Cancel.
    let ticket: Ticket

    // MARK: Edit-mode state

    @State private var isEditing: Bool = false
    @State private var draftTitle: String = ""
    @State private var draftType: TicketType = .story
    @State private var draftStatus: TicketStatus = .backlog
    @State private var draftPriority: TicketPriority = .medium
    @State private var draftDescription: String = ""
    @State private var draftAssignee: String = ""

    // MARK: Async state

    @State private var isSaving: Bool = false
    @State private var saveError: String?
    @State private var showDeleteConfirm: Bool = false

    // MARK: Formatters

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    // MARK: Body

    var body: some View {
        ZStack {
            content
                .navigationTitle(isEditing ? "Edit Ticket" : ticket.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { toolbarContent }
                .confirmationDialog(
                    "Delete Ticket",
                    isPresented: $showDeleteConfirm,
                    titleVisibility: .visible
                ) {
                    Button("Delete", role: .destructive) { deleteTicket() }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("This action cannot be undone.")
                }

            if isSaving {
                savingOverlay
            }
        }
    }

    // MARK: Main content

    @ViewBuilder
    private var content: some View {
        Form {
            // ── Error banner ──────────────────────────────────────────
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

            // ── Title ─────────────────────────────────────────────────
            Section("Title") {
                if isEditing {
                    TextField("Ticket title", text: $draftTitle)
                } else {
                    Text(ticket.title)
                }
            }

            // ── Metadata ──────────────────────────────────────────────
            Section("Details") {
                if isEditing {
                    Picker("Type", selection: $draftType) {
                        ForEach(TicketType.allCases) { type in
                            Text(type.rawValue.capitalized).tag(type)
                        }
                    }
                    .pickerStyle(.menu)

                    Picker("Status", selection: $draftStatus) {
                        ForEach(TicketStatus.allCases) { status in
                            Text(status.displayName).tag(status)
                        }
                    }
                    .pickerStyle(.menu)

                    Picker("Priority", selection: $draftPriority) {
                        ForEach(TicketPriority.allCases) { priority in
                            Text(priority.rawValue.capitalized).tag(priority)
                        }
                    }
                    .pickerStyle(.menu)
                } else {
                    metadataRow(label: "Type",     value: ticket.type.rawValue.capitalized)
                    metadataRow(label: "Status",   value: ticket.status.displayName)
                    metadataRow(label: "Priority", value: ticket.priority.rawValue.capitalized)
                }
            }

            // ── Assignee ──────────────────────────────────────────────
            Section("Assignee") {
                if isEditing {
                    TextField("Username or email", text: $draftAssignee)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } else if let assignee = ticket.assignee, !assignee.isEmpty {
                    Text(assignee)
                } else {
                    Text("Unassigned")
                        .foregroundStyle(.secondary)
                }
            }

            // ── Description ───────────────────────────────────────────
            Section("Description") {
                if isEditing {
                    TextEditor(text: $draftDescription)
                        .frame(minHeight: 120)
                } else if let desc = ticket.description, !desc.isEmpty {
                    // Markdown prose + inline Mermaid blocks (matches the
                    // web UI's renderer — see MarkdownView for the splitter
                    // and MermaidView for the WKWebView).
                    MarkdownView(text: desc)
                } else {
                    Text("No description")
                        .foregroundStyle(.secondary)
                }
            }

            // ── Labels ────────────────────────────────────────────────
            if !ticket.labels.isEmpty {
                Section("Labels") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(ticket.labels, id: \.self) { label in
                                Text(label)
                                    .font(.caption.weight(.medium))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            // ── Timestamps ────────────────────────────────────────────
            Section("Timestamps") {
                metadataRow(
                    label: "Created",
                    value: Self.dateFormatter.string(from: ticket.createdAt)
                )
                metadataRow(
                    label: "Updated",
                    value: Self.dateFormatter.string(from: ticket.updatedAt)
                )
            }

            // ── Danger zone ───────────────────────────────────────────
            Section {
                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    Label("Delete Ticket", systemImage: "trash")
                }
                .disabled(isSaving)
            }
        }
        .disabled(isSaving)
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if isEditing {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { saveEdits() }
                    .disabled(draftTitle.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                    .bold()
            }
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { cancelEdits() }
                    .disabled(isSaving)
            }
        } else {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("Edit") { beginEditing() }
            }
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
                Text("Saving…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(28)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }

    // MARK: Helpers

    private func metadataRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
        }
    }

    // MARK: Actions

    private func beginEditing() {
        draftTitle       = ticket.title
        draftType        = ticket.type
        draftStatus      = ticket.status
        draftPriority    = ticket.priority
        draftDescription = ticket.description ?? ""
        draftAssignee    = ticket.assignee ?? ""
        saveError        = nil
        isEditing        = true
    }

    private func cancelEdits() {
        isEditing = false
        saveError = nil
    }

    private func saveEdits() {
        let trimmedTitle = draftTitle.trimmingCharacters(in: .whitespaces)
        guard !trimmedTitle.isEmpty else { return }

        let update = TicketUpdate(
            title:       trimmedTitle,
            status:      draftStatus,
            priority:    draftPriority,
            description: draftDescription.isEmpty ? nil : draftDescription,
            assignee:    draftAssignee.isEmpty ? nil : draftAssignee
        )

        isSaving  = true
        saveError = nil

        Task {
            defer { isSaving = false }
            do {
                try await store.updateTicket(ticket.id, update: update)
                isEditing = false
            } catch {
                saveError = error.localizedDescription
            }
        }
    }

    private func deleteTicket() {
        isSaving = true

        Task {
            defer { isSaving = false }
            do {
                try await store.deleteTicket(ticket.id)
                dismiss()
            } catch {
                saveError = error.localizedDescription
            }
        }
    }
}

// MARK: - Preview

#Preview("Read-only") {
    let store = AppStore()
    let ticket = Ticket(
        id: "TKT-1",
        title: "Implement login screen",
        type: .story,
        status: .in_progress,
        priority: .high,
        description: "Build the auth flow with Face ID support.",
        parentId: nil,
        assignee: "bri",
        labels: ["auth", "ios"],
        createdAt: .now.addingTimeInterval(-86400 * 3),
        updatedAt: .now.addingTimeInterval(-3600)
    )
    return NavigationStack {
        TicketDetailView(ticket: ticket)
    }
    .environment(store)
}

#Preview("Edit mode") {
    let store = AppStore()
    let ticket = Ticket(
        id: "TKT-2",
        title: "Fix crash on launch",
        type: .bug,
        status: .todo,
        priority: .urgent,
        description: nil,
        parentId: nil,
        assignee: nil,
        labels: [],
        createdAt: .now.addingTimeInterval(-3600),
        updatedAt: .now
    )
    return NavigationStack {
        TicketDetailView(ticket: ticket)
    }
    .environment(store)
}
