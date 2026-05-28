import SwiftUI

struct CardView: View {

    let ticket: Ticket
    let onTap: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // MARK: Title
            Text(ticket.title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)

            // MARK: Badges
            HStack(spacing: 6) {
                // Priority badge
                Label(ticket.priority.displayName, systemImage: ticket.priority.systemImage)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(ticket.priority.foregroundColor)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(ticket.priority.backgroundColor, in: Capsule())

                // Type badge
                Label(ticket.type.displayName, systemImage: ticket.type.systemImage)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .onTapGesture { onTap() }
    }
}

// MARK: - TicketPriority display helpers

private extension TicketPriority {
    var displayName: String {
        switch self {
        case .low:    "Low"
        case .medium: "Medium"
        case .high:   "High"
        case .urgent: "Urgent"
        }
    }

    var systemImage: String {
        switch self {
        case .low:    "arrow.down"
        case .medium: "minus"
        case .high:   "arrow.up"
        case .urgent: "exclamationmark.2"
        }
    }

    var foregroundColor: Color {
        switch self {
        case .low:    .secondary
        case .medium: .blue
        case .high:   .orange
        case .urgent: .red
        }
    }

    var backgroundColor: Color {
        switch self {
        case .low:    Color(.systemGray5)
        case .medium: Color(.systemBlue).opacity(0.15)
        case .high:   Color(.systemOrange).opacity(0.15)
        case .urgent: Color(.systemRed).opacity(0.15)
        }
    }
}

// MARK: - TicketType display helpers

private extension TicketType {
    var displayName: String {
        switch self {
        case .story: "Story"
        case .bug:   "Bug"
        case .epic:  "Epic"
        }
    }

    var systemImage: String {
        switch self {
        case .story: "bookmark"
        case .bug:   "ant"
        case .epic:  "bolt"
        }
    }
}
