import SwiftUI

/// A single row in the hub discovery list.
///
/// Shows the Bonjour service name, the resolved host:port, a scheme badge
/// (HTTPS / HTTP), and optional auth method chips.  Tapping the row invokes
/// `onConnect` and shows an inline progress indicator while the connection
/// handshake is in flight.
struct HubRowView: View {

    let hub: HubInfo
    /// Called when the user taps the row.  The caller is responsible for
    /// performing the actual connection and surfacing any errors.
    let onConnect: () async -> Void

    // MARK: Private state

    @State private var isConnecting: Bool = false

    // MARK: Body

    var body: some View {
        Button {
            guard !isConnecting else { return }
            Task {
                isConnecting = true
                await onConnect()
                isConnecting = false
            }
        } label: {
            HStack(spacing: 12) {
                // ── Hub icon ────────────────────────────────────────────────
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(hub.scheme == "https" ? Color.accentColor.opacity(0.12) : Color.orange.opacity(0.12))
                    Image(systemName: hub.scheme == "https" ? "lock.shield" : "network")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(hub.scheme == "https" ? Color.accentColor : .orange)
                }
                .frame(width: 44, height: 44)

                // ── Text stack ──────────────────────────────────────────────
                VStack(alignment: .leading, spacing: 2) {
                    Text(hub.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text("\(hub.host):\(hub.port)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    if !hub.authMethods.isEmpty {
                        HStack(spacing: 4) {
                            ForEach(hub.authMethods, id: \.self) { method in
                                Text(method.uppercased())
                                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                                    .padding(.horizontal, 5)
                                    .padding(.vertical, 2)
                                    .background(Color.secondary.opacity(0.15), in: Capsule())
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.top, 2)
                    }
                }

                Spacer(minLength: 0)

                // ── Scheme badge + connecting indicator ─────────────────────
                VStack(alignment: .trailing, spacing: 6) {
                    SchemeBadge(scheme: hub.scheme)

                    if isConnecting {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isConnecting)
    }
}

// MARK: - SchemeBadge

private struct SchemeBadge: View {
    let scheme: String

    var isSecure: Bool { scheme.lowercased() == "https" }

    var body: some View {
        Text(isSecure ? "HTTPS" : "HTTP")
            .font(.system(size: 10, weight: .bold, design: .monospaced))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(isSecure ? Color.green.opacity(0.15) : Color.orange.opacity(0.15), in: Capsule())
            .foregroundStyle(isSecure ? .green : .orange)
    }
}

// MARK: - Preview

#Preview("HTTPS hub") {
    List {
        HubRowView(
            hub: HubInfo(
                id: "scope.local:8443",
                name: "Bri's MacBook Pro",
                host: "scope.local",
                port: 8443,
                scheme: "https",
                caFingerprint: "ab:cd:ef:01:23:45",
                authMethods: ["token", "mtls"]
            ),
            onConnect: {}
        )
        HubRowView(
            hub: HubInfo(
                id: "192.168.1.5:8080",
                name: "Dev Hub",
                host: "192.168.1.5",
                port: 8080,
                scheme: "http",
                caFingerprint: nil,
                authMethods: ["token"]
            ),
            onConnect: {}
        )
    }
}
