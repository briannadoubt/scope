import SwiftUI
import UIKit

/// Empty-state shown on the board when the active workspace has no tickets.
///
/// Scope is meant to be planned with — and worked through — by a coding agent.
/// The primary call to action nudges the user toward that flow by copying a
/// starter prompt to the clipboard that they can paste into Claude / Codex /
/// Cursor in their terminal. The secondary action falls back to adding a
/// ticket by hand via `NewTicketView`.
struct BoardEmptyStateView: View {

    /// Workspace the prompt should reference. May be `nil` in odd edge cases
    /// (the parent only renders this view when a workspace is selected, but
    /// the binding keeps things honest).
    let workspace: Workspace?

    /// Tapped when the user picks the "Add manually" CTA. The parent opens
    /// the `NewTicketView` sheet — keeping that state at the BoardView level
    /// avoids a second sheet binding here.
    let onAddManually: () -> Void

    @State private var didCopyPrompt: Bool = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer(minLength: 0)

            icon

            VStack(spacing: 8) {
                Text("Plan your first epic")
                    .font(.title3.weight(.semibold))

                Text(descriptionText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                Button {
                    copyAgentPrompt()
                } label: {
                    Label(
                        didCopyPrompt ? "Prompt copied" : "Plan with your agent",
                        systemImage: didCopyPrompt ? "checkmark" : "sparkles"
                    )
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .animation(.easeInOut(duration: 0.18), value: didCopyPrompt)
                .sensoryFeedback(.success, trigger: didCopyPrompt) { _, new in new }

                Button {
                    onAddManually()
                } label: {
                    Label("Add a ticket manually", systemImage: "plus")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 4)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
            .frame(maxWidth: 320)
            .padding(.horizontal, 24)

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Pieces

    private var icon: some View {
        ZStack {
            Circle()
                .fill(Color.accentColor.opacity(0.10))
                .frame(width: 96, height: 96)
            Image(systemName: "sparkles")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Color.accentColor)
        }
    }

    private var descriptionText: String {
        if let name = workspace?.displayName, !name.isEmpty {
            return "\(name) doesn't have any tickets yet. Ask your coding agent to scope an epic — or add one yourself."
        }
        return "This workspace doesn't have any tickets yet. Ask your coding agent to scope an epic — or add one yourself."
    }

    // MARK: - Actions

    private func copyAgentPrompt() {
        UIPasteboard.general.string = starterPrompt
        didCopyPrompt = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            didCopyPrompt = false
        }
    }

    /// Prompt the user can paste into their agent. We name the workspace
    /// (and key, if we have one) so the agent has enough context to call the
    /// right `scope` commands without a follow-up clarification.
    private var starterPrompt: String {
        let name = workspace?.displayName ?? "this project"
        let keyHint: String
        if let key = workspace?.key, !key.isEmpty {
            keyHint = " (workspace key `\(key)`)"
        } else {
            keyHint = ""
        }
        return """
        Plan an epic for \(name)\(keyHint) using the Scope CLI.

        - Create an epic that captures the next meaningful body of work.
        - Break it down into stories (and bugs, where relevant) underneath it.
        - Use `scope ticket create … -t epic|story|bug --parent <epic>` and \
        link related tickets with `scope link add`.
        - When you're done, show me the resulting board with `scope --json ticket list`.
        """
    }
}

// MARK: - Preview

#Preview("Empty board — with workspace") {
    BoardEmptyStateView(
        workspace: Workspace(
            id: "ws-1",
            label: "scope",
            scopeDir: "/repo/.scope",
            key: "SCP",
            name: "Scope",
            description: nil,
            overview: nil
        ),
        onAddManually: {}
    )
}

#Preview("Empty board — no workspace metadata") {
    BoardEmptyStateView(workspace: nil, onAddManually: {})
}
