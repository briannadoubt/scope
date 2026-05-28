import SwiftUI

struct ColumnView: View {

    let status: TicketStatus
    let tickets: [Ticket]
    let onTap: (Ticket) -> Void

    private static let columnWidth: CGFloat = 300

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // MARK: Header
            HStack(spacing: 8) {
                Circle()
                    .fill(status.accentColor)
                    .frame(width: 8, height: 8)

                Text(status.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)

                Spacer()

                if !tickets.isEmpty {
                    Text("\(tickets.count)")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()
                .padding(.horizontal, 8)

            // MARK: Cards
            ScrollView(.vertical, showsIndicators: false) {
                LazyVStack(spacing: 8) {
                    ForEach(tickets) { ticket in
                        CardView(ticket: ticket) {
                            onTap(ticket)
                        }
                    }

                    if tickets.isEmpty {
                        Text("No tickets")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 24)
                    }
                }
                .padding(10)
            }
        }
        .frame(width: Self.columnWidth)
        .background(Color(uiColor: .secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - TicketStatus helpers

private extension TicketStatus {
    var accentColor: Color {
        switch self {
        case .backlog:     .secondary
        case .todo:        .blue
        case .in_progress: .orange
        case .in_review:   .purple
        case .done:        .green
        case .cancelled:   .gray
        }
    }
}
