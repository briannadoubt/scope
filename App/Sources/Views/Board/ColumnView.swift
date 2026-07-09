import SwiftUI

struct ColumnView: View {

    let column: BoardColumn
    let tickets: [Ticket]
    let flow: [TicketStatus]
    let onTap: (Ticket) -> Void

    private static let columnWidth: CGFloat = 300

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // MARK: Header
            HStack(spacing: 8) {
                Circle()
                    .fill(column.accentColor)
                    .frame(width: 8, height: 8)

                Text(column.label)
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
                        // Horizontal swipe → advance/regress status (SCP-92).
                        // SwipeCardContainer reveals a destructive-style label
                        // during the gesture and commits on release past the
                        // threshold; the resulting SSE update animates the
                        // card into its new column.
                        SwipeCardContainer(ticket: ticket, flow: flow) {
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

// MARK: - BoardColumn helpers

extension BoardColumn {
    var accentColor: Color {
        Color(hex: color) ?? status.accentColor
    }
}

extension TicketStatus {
    var accentColor: Color {
        switch self {
        case .backlog: .secondary
        case .todo: .blue
        case .in_progress: .orange
        case .in_review: .purple
        case .done: .green
        case .cancelled: .gray
        default: .secondary
        }
    }
}

private extension Color {
    init?(hex: String) {
        let trimmed = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard trimmed.count == 6, let value = Int(trimmed, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xff) / 255
        let g = Double((value >> 8) & 0xff) / 255
        let b = Double(value & 0xff) / 255
        self = Color(red: r, green: g, blue: b)
    }
}
