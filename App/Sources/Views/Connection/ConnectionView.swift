import SwiftUI

/// Full-screen onboarding shown when no hub is connected.
///
/// Automatically starts Bonjour scanning on appear and stops it on disappear.
/// Users can tap any discovered hub to connect, or open a manual-entry sheet
/// to type in a custom IP:port + bearer token.
struct ConnectionView: View {

    @Environment(AppStore.self) private var store

    // MARK: Private state

    @State private var discovery = HubDiscovery()
    @State private var isConnecting: Bool = false
    @State private var connectError: String?
    @State private var showManualEntry: Bool = false
    /// Pairing sheet state for Bonjour-discovered hubs.
    @State private var pendingHub: HubInfo? = nil

    // MARK: Body

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Find Hub")
                .navigationBarTitleDisplayMode(.large)
                .toolbar { toolbarContent }
                .alert("Connection Error", isPresented: .constant(connectError != nil), actions: {
                    Button("OK") { connectError = nil }
                }, message: {
                    if let msg = connectError {
                        Text(msg)
                    }
                })
                .sheet(isPresented: $showManualEntry) {
                    ManualEntrySheet { url, token in
                        await connect(to: url, token: token)
                    }
                }
                .sheet(item: $pendingHub) { hub in
                    PairingView(hub: hub)
                        .environment(store)
                }
        }
        .onAppear { discovery.startScanning() }
        .onDisappear { discovery.stopScanning() }
    }

    // MARK: Sub-views

    @ViewBuilder
    private var content: some View {
        if discovery.discovered.isEmpty {
            emptyState
        } else {
            hubList
        }
    }

    private var emptyState: some View {
        VStack(spacing: 20) {
            Spacer()

            ZStack {
                Circle()
                    .fill(Color.accentColor.opacity(0.08))
                    .frame(width: 96, height: 96)
                Image(systemName: "network.badge.shield.half.filled")
                    .font(.system(size: 40, weight: .light))
                    .foregroundStyle(Color.accentColor)
            }

            VStack(spacing: 8) {
                Text("Looking for Hubs")
                    .font(.title3.weight(.semibold))

                Text("Scanning for Scope hubs on your network…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
            }

            ProgressView()
                .padding(.top, 4)

            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private var hubList: some View {
        List {
            Section {
                ForEach(discovery.discovered) { hub in
                    HubRowView(hub: hub) {
                        // Show pairing sheet — first-time setup gets a 6-digit code
                        // from `scope pair` on the Mac; subsequent connects reuse the
                        // stored mTLS identity.
                        pendingHub = hub
                    }
                }
            } header: {
                HStack {
                    Text("Available Hubs")
                    Spacer()
                    if discovery.isScanning {
                        HStack(spacing: 4) {
                            ProgressView()
                                .controlSize(.mini)
                            Text("Scanning")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .animation(.default, value: discovery.discovered)
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigationBarTrailing) {
            Button {
                showManualEntry = true
            } label: {
                Label("Enter manually", systemImage: "keyboard")
            }
        }
    }

    // MARK: Connection logic

    @MainActor
    private func connect(to url: URL, token: String?, caFingerprint: String? = nil) async {
        guard !isConnecting else { return }
        isConnecting = true
        connectError = nil
        pendingHub = nil

        await store.connect(
            to: url,
            token: token.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 },
            caFingerprint: caFingerprint
        )

        if let storeError = store.error {
            connectError = storeError
        }

        isConnecting = false
    }
}

// MARK: - ManualEntrySheet

/// A sheet that lets the user type a raw `host:port` (or full URL) and an optional
/// bearer token, then connect.
private struct ManualEntrySheet: View {

    let onConnect: (URL, String?) async -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var addressText: String = ""
    @State private var tokenText: String = ""
    @State private var isConnecting: Bool = false
    @State private var validationError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("192.168.1.x:4321 or scope.local:4321", text: $addressText)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .submitLabel(.next)
                } header: {
                    Text("Hub Address")
                } footer: {
                    if let err = validationError {
                        Text(err).foregroundStyle(.red)
                    } else {
                        Text("Tip: use \(Image(systemName: "network")) scope.local:4321 when on the same Wi-Fi as your hub.")
                    }
                }

                Section {
                    SecureField("Bearer token (from scope auth show)", text: $tokenText)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Token")
                } footer: {
                    Text("Run \(Text("`scope auth show`").font(.system(.footnote, design: .monospaced))) on your Mac to get this.")
                }

                Section {
                    Button { attemptConnect() } label: {
                        HStack {
                            Spacer()
                            if isConnecting {
                                ProgressView().controlSize(.small).padding(.trailing, 6)
                            }
                            Text(isConnecting ? "Connecting…" : "Connect").bold()
                            Spacer()
                        }
                    }
                    .disabled(addressText.trimmingCharacters(in: .whitespaces).isEmpty || isConnecting)
                }
            }
            .navigationTitle("Manual Entry")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func attemptConnect() {
        let raw = addressText.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty else { return }
        guard let url = normalizeURL(raw) else {
            validationError = "Please enter a valid address, e.g. 192.168.1.5:4321"
            return
        }
        validationError = nil
        isConnecting = true
        let tok = tokenText.trimmingCharacters(in: .whitespaces)
        Task {
            await onConnect(url, tok.isEmpty ? nil : tok)
            isConnecting = false
            dismiss()
        }
    }

    /// Turns bare `host:port` into a full URL.
    /// The Scope hub always serves HTTPS, so all bare addresses get `https://`.
    private func normalizeURL(_ raw: String) -> URL? {
        if raw.contains("://") { return URL(string: raw) }
        let candidate = "https://\(raw)"
        return URL(string: candidate).flatMap { $0.host != nil ? $0 : nil }
    }
}

// MARK: - Preview

#Preview("Empty — scanning") {
    ConnectionView()
        .environment(AppStore())
}
