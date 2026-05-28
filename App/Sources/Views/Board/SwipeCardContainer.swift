import SwiftUI

/// Wraps a kanban `CardView` with a horizontal swipe gesture that advances or
/// regresses the ticket's status. Mirrors the web UI's drag-and-drop:
///
/// - Swipe **left** → advance to the next status in `TicketStatus.flow`
///   (`backlog → todo → in_progress → in_review → done`).
/// - Swipe **right** → regress to the previous.
///
/// While the swipe is in progress the card slides and a destructive-style
/// action label is revealed behind it ("→ In Review" on left swipe,
/// "Backlog ←" on right swipe). On release past the commit threshold we PATCH
/// `/api/tickets/:id` via `AppStore.updateTicket`; the live SSE update will
/// then move the card into its new column automatically. Before the
/// threshold the card snaps back.
///
/// Cards at the ends of the flow (backlog can't regress, done can't advance,
/// cancelled is sideways) just won't swipe in the disallowed direction — the
/// reveal label stays hidden and the card resists the drag at zero offset.
struct SwipeCardContainer: View {
    let ticket: Ticket
    let onTap: () -> Void

    @Environment(AppStore.self) private var store

    @State private var offset: CGFloat = 0
    @State private var isCommitting: Bool = false
    @State private var commitError: String?

    /// The swipe distance (in points) at which release commits the action.
    /// Picked to match Apple's first-party swipe behaviour: small enough that
    /// a quick gesture works, large enough that an accidental brush doesn't.
    private static let commitThreshold: CGFloat = 80

    /// Maximum visible reveal width. The card never slides past this — it
    /// resists further drag with a small rubber-band so the UI doesn't feel
    /// like it's coming apart in the user's hand.
    private static let revealMax: CGFloat = 140

    var body: some View {
        ZStack {
            revealBackground
            CardView(ticket: ticket, onTap: onTap)
                .offset(x: offset)
                .opacity(isCommitting ? 0.55 : 1)
                .animation(.interactiveSpring(response: 0.32, dampingFraction: 0.78), value: offset)
                .gesture(dragGesture)
        }
        .alert("Status change failed", isPresented: .init(
            get: { commitError != nil },
            set: { if !$0 { commitError = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(commitError ?? "")
        }
    }

    // MARK: Reveal layer

    @ViewBuilder
    private var revealBackground: some View {
        // Two labels behind the card. Only one is visible at a time depending
        // on which way the user is dragging. They sit at the leading / trailing
        // edges of the card's container so they appear to slide out from
        // under it.
        HStack {
            if offset > 0, let prev = ticket.status.previous {
                RevealLabel(text: prev.displayName, systemImage: "arrow.left", tint: .orange,
                            alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            Spacer(minLength: 0)
            if offset < 0, let next = ticket.status.next {
                RevealLabel(text: next.displayName, systemImage: "arrow.right", tint: .green,
                            alignment: .trailing)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, 4)
    }

    // MARK: Gesture

    private var dragGesture: some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .local)
            .onChanged { value in
                guard !isCommitting else { return }
                offset = clampedOffset(value.translation.width)
            }
            .onEnded { value in
                guard !isCommitting else { return }
                let dx = clampedOffset(value.translation.width)
                if dx <= -Self.commitThreshold, let next = ticket.status.next {
                    commit(to: next)
                } else if dx >= Self.commitThreshold, let prev = ticket.status.previous {
                    commit(to: prev)
                } else {
                    offset = 0
                }
            }
    }

    /// Clamp the raw drag amount into the allowed range for this card's
    /// current status: zero in disallowed directions, soft cap at `revealMax`
    /// in allowed directions.
    private func clampedOffset(_ raw: CGFloat) -> CGFloat {
        if raw < 0 {
            guard ticket.status.next != nil else { return 0 }
            return max(raw, -Self.revealMax * 1.15)
        } else if raw > 0 {
            guard ticket.status.previous != nil else { return 0 }
            return min(raw, Self.revealMax * 1.15)
        }
        return 0
    }

    // MARK: Commit

    private func commit(to newStatus: TicketStatus) {
        isCommitting = true
        // Slide the card the rest of the way off so the transition reads as
        // "the card left the column" — then snap back to zero once the SSE
        // update arrives (which will move the card to its real new column).
        offset = (newStatus == ticket.status.next ? -1 : 1) * Self.revealMax

        Task {
            do {
                try await store.updateTicket(
                    ticket.id,
                    update: TicketUpdate(status: newStatus)
                )
            } catch {
                commitError = error.localizedDescription
            }
            // Always restore offset — on success the live SSE update will
            // remove this card from its current column anyway; on failure
            // the user sees the card return to its original column.
            offset = 0
            isCommitting = false
        }
    }
}

// MARK: - Reveal label

private struct RevealLabel: View {
    let text: String
    let systemImage: String
    let tint: Color
    let alignment: Alignment

    var body: some View {
        HStack(spacing: 6) {
            if alignment == .trailing { Spacer(minLength: 0) }
            Label {
                Text(text)
                    .font(.caption.weight(.semibold))
            } icon: {
                Image(systemName: systemImage)
            }
            .labelStyle(.titleAndIcon)
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(tint, in: Capsule())
            if alignment == .leading { Spacer(minLength: 0) }
        }
        .padding(.horizontal, 8)
    }
}

#Preview("Swipe card — in_progress") {
    let store = AppStore()
    let ticket = Ticket(
        id: "TKT-3",
        title: "Wire up swipe gestures",
        type: .story,
        status: .in_progress,
        priority: .high,
        description: nil,
        parentId: nil,
        assignee: nil,
        labels: [],
        createdAt: .now,
        updatedAt: .now
    )
    return SwipeCardContainer(ticket: ticket) {}
        .environment(store)
        .padding()
        .background(Color(uiColor: .systemBackground))
}
