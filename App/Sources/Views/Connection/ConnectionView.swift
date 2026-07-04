import SwiftUI

/// Full-screen onboarding shown when no hub is connected.
///
/// Automatically starts Bonjour scanning on appear and stops it on disappear.
/// Users can connect to a hosted Scope remote with an API key, or tap a
/// discovered LAN hub when they are on the same network as their desktop.
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
                        await connect(to: url, token: token, remember: true)
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
                Text("Connect to Scope")
                    .font(.title3.weight(.semibold))

                Text("Use your hosted remote to see agent updates from anywhere.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
            }

            Button {
                showManualEntry = true
            } label: {
                Label("Connect to remote", systemImage: "cloud")
            }
            .buttonStyle(.borderedProminent)

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
                    HubRowView(hub: hub) { tap(hub) }
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
                Label("Remote", systemImage: "cloud")
            }
        }
    }

    // MARK: Connection logic

    /// Handler for tapping a discovered hub row. Branches on whether the
    /// Keychain already has an mTLS identity for the hub:
    ///
    /// - **Already paired:** Build a paired URLSession and `connect()`
    ///   immediately. RootView swaps in MainTabView once `store.client`
    ///   is set. No pairing sheet flashes on screen.
    /// - **Not paired:** Present `PairingView` so the user can enter the
    ///   one-time 6-digit code from `scope pair` on the Mac.
    ///
    /// The check uses `KeychainStore.shared.isPaired(for:)`, the same
    /// helper PairingManager uses to seed its own `isPaired` flag — so
    /// the two paths can never disagree about whether a hub is paired.
    private func tap(_ hub: HubInfo) {
        if KeychainStore.shared.isPaired(for: hub.id) {
            let session = PairedSession.make(for: hub)
            Task { await store.connect(to: hub.baseURL, session: session) }
        } else {
            pendingHub = hub
        }
    }

    @MainActor
    private func connect(
        to url: URL,
        token: String?,
        caFingerprint: String? = nil,
        remember: Bool = false
    ) async -> Bool {
        guard !isConnecting else { return false }
        isConnecting = true
        connectError = nil
        pendingHub = nil

        await store.connect(
            to: url,
            token: token.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 },
            caFingerprint: caFingerprint,
            remember: remember
        )

        if let storeError = store.error {
            connectError = storeError
        }

        isConnecting = false
        return connectError == nil
    }
}

// MARK: - ManualEntrySheet

/// A sheet that lets the user connect to the hosted remote with its URL and API key.
private struct ManualEntrySheet: View {

    let onConnect: (URL, String?) async -> Bool

    @Environment(\.dismiss) private var dismiss

    @State private var addressText: String = ""
    @State private var tokenText: String = ""
    @State private var isConnecting: Bool = false
    @State private var validationError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://scope-hub.example.com", text: $addressText)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .submitLabel(.next)
                } header: {
                    Text("Remote URL")
                } footer: {
                    if let err = validationError {
                        Text(err).foregroundStyle(.red)
                    } else {
                        Text("Use the hosted Scope hub that your desktop workspace syncs to.")
                    }
                }

                Section {
                    SecureField("sk_…", text: $tokenText)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("API Key")
                } footer: {
                    Text("The app saves this in Keychain and uses it for tickets and live updates.")
                }

                Section {
                    Button { attemptConnect() } label: {
                        HStack {
                            Spacer()
                            if isConnecting {
                                ProgressView().controlSize(.small).padding(.trailing, 6)
                            }
                            Text(isConnecting ? "Connecting…" : "Connect to remote").bold()
                            Spacer()
                        }
                    }
                    .disabled(
                        addressText.trimmingCharacters(in: .whitespaces).isEmpty ||
                        tokenText.trimmingCharacters(in: .whitespaces).isEmpty ||
                        isConnecting
                    )
                }
            }
            .navigationTitle("Remote")
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
            validationError = "Enter a valid remote URL."
            return
        }
        let tok = tokenText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !tok.isEmpty else {
            validationError = "Enter an API key for the remote."
            return
        }
        validationError = nil
        isConnecting = true
        Task {
            let connected = await onConnect(url, tok)
            isConnecting = false
            if connected {
                dismiss()
            }
        }
    }

    /// Turns a bare host into a full HTTPS URL.
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
