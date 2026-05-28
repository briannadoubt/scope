import SwiftUI
import UIKit

// MARK: - PairingView

struct PairingView: View {

    let hub: HubInfo

    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var manager: PairingManager
    @State private var code: String = ""
    @State private var deviceName: String = UIDevice.current.name

    // MARK: - Init

    init(hub: HubInfo) {
        self.hub = hub
        self._manager = State(initialValue: PairingManager(hub: hub))
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            ZStack {
                Form {
                    codeSection
                    deviceNameSection
                    actionSection
                    if let errorText = manager.error {
                        errorSection(errorText)
                    }
                }
                .navigationTitle("Pair with \(hub.name)")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
                .disabled(manager.isPairing)
                .task {
                    // Already paired with this hub from a previous run — the
                    // Keychain has the identity, so skip the code-entry step
                    // and connect immediately. We can't rely on
                    // `.onChange(of: manager.isPaired)` for this because
                    // `isPaired` is already true on appear (set in
                    // PairingManager.init from the Keychain check), so the
                    // value never *transitions* and onChange would silently
                    // do nothing — that was the bug behind "pairing worked
                    // on the CLI but the app stayed on the pair sheet."
                    if manager.isPaired { handlePairingSuccess() }
                }

                if manager.isPairing {
                    pairingOverlay
                }
            }
        }
    }

    // MARK: - Sections

    private var codeSection: some View {
        Section {
            TextField("6-digit code", text: $code)
                .keyboardType(.numberPad)
                .font(.system(.body, design: .monospaced))
                .onChange(of: code) { _, newValue in
                    // Clamp to 6 digits.
                    let digits = newValue.filter(\.isNumber)
                    if digits.count > 6 {
                        code = String(digits.prefix(6))
                    } else if digits != newValue {
                        code = digits
                    }
                }

            Text("Run `scope pair` on your Mac to get a code.")
                .font(.caption)
                .foregroundStyle(.secondary)
        } header: {
            Text("Pairing Code")
        }
    }

    private var deviceNameSection: some View {
        Section {
            TextField("Device name", text: $deviceName)
                .autocorrectionDisabled()
        } header: {
            Text("Device Name")
        } footer: {
            Text("Used to identify this device on the hub.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var actionSection: some View {
        Section {
            Button {
                Task { try? await attemptPairing() }
            } label: {
                HStack {
                    Spacer()
                    Text("Pair")
                        .fontWeight(.semibold)
                    Spacer()
                }
            }
            .disabled(!canPair)
        }
    }

    private func errorSection(_ message: String) -> some View {
        Section {
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.callout)
        }
    }

    // MARK: - Overlay

    private var pairingOverlay: some View {
        ZStack {
            Color.black.opacity(0.3)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                ProgressView()
                    .controlSize(.large)
                    .tint(.white)
                Text("Pairing…")
                    .font(.headline)
                    .foregroundStyle(.white)
            }
            .padding(32)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
    }

    // MARK: - Helpers

    private var canPair: Bool {
        code.filter(\.isNumber).count == 6 && !deviceName.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private func attemptPairing() async throws {
        let trimmedCode = code.filter(\.isNumber)
        let trimmedName = deviceName.trimmingCharacters(in: .whitespaces)
        try await manager.pair(code: trimmedCode, deviceName: trimmedName)
        // pair() throws on failure; reaching this line means it succeeded.
        // Call the transition directly instead of waiting for the @Observable
        // change to propagate through .onChange — see the .task modifier in
        // body for the full rationale.
        handlePairingSuccess()
    }

    private func handlePairingSuccess() {
        // Build a mTLS-capable URLSession using the persisted identity and CA.
        let pairedSession = makePairedSession()
        Task {
            await store.connect(to: hub.baseURL, session: pairedSession)
            dismiss()
        }
    }

    // MARK: - Paired URLSession

    private func makePairedSession() -> URLSession {
        // Reuse the file-scope factory so ConnectionView's "already-paired
        // hub → skip the pair sheet" shortcut shares the same delegate setup.
        PairedSession.make(for: hub)
    }
}

// MARK: - Paired URLSession factory
//
// Lives at file scope inside a caseless enum so both this view (post-
// pairing) and ConnectionView (already paired on tap) can build a session
// without instantiating PairingView. Named `PairedSession` instead of
// `Scope` to avoid shadowing the module name.

enum PairedSession {
    /// Build a URLSession that authenticates to `hub` using the mTLS identity
    /// stored in the Keychain by a previous pairing run. The session pins the
    /// server's CA to the cert stored alongside that identity.
    static func make(for hub: HubInfo) -> URLSession {
        let delegate = PairedURLSessionDelegate(hubId: hub.id)
        let config = URLSessionConfiguration.default
        config.tlsMinimumSupportedProtocolVersion = .TLSv12
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }
}

// MARK: - PairedURLSessionDelegate

/// `URLSessionDelegate` for a session that has already completed pairing.
/// Handles:
///   - Server trust: pins against the CA cert stored in Keychain for this hub.
///   - Client identity: provides the signed client certificate from Keychain.
final class PairedURLSessionDelegate: NSObject, URLSessionDelegate {

    private let hubId: String

    init(hubId: String) {
        self.hubId = hubId
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        switch challenge.protectionSpace.authenticationMethod {

        case NSURLAuthenticationMethodServerTrust:
            guard let serverTrust = challenge.protectionSpace.serverTrust else {
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }
            handleServerTrust(serverTrust, completionHandler: completionHandler)

        case NSURLAuthenticationMethodClientCertificate:
            handleClientCertificate(completionHandler: completionHandler)

        default:
            completionHandler(.performDefaultHandling, nil)
        }
    }

    // MARK: - Server trust pinning

    private func handleServerTrust(
        _ serverTrust: SecTrust,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let pinnedCA = KeychainStore.shared.loadCACert(for: hubId) else {
            // No stored CA — fall through to system evaluation.
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // Build a custom trust policy anchored exclusively to our stored CA cert.
        let anchors = [pinnedCA]
        let setAnchorStatus = SecTrustSetAnchorCertificates(serverTrust, anchors as CFArray)
        guard setAnchorStatus == errSecSuccess else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        // Do not fall back to system anchors.
        SecTrustSetAnchorCertificatesOnly(serverTrust, true)

        var cfError: CFError?
        let trusted = SecTrustEvaluateWithError(serverTrust, &cfError)

        if trusted {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    // MARK: - Client certificate

    private func handleClientCertificate(
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let identity = KeychainStore.shared.loadIdentity(for: hubId) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        // Build the certificate chain to present to the server.
        var certRef: SecCertificate?
        let copyStatus = SecIdentityCopyCertificate(identity, &certRef)
        let certs: [SecCertificate] = (copyStatus == errSecSuccess) ? certRef.map { [$0] } ?? [] : []

        let credential = URLCredential(
            identity: identity,
            certificates: certs,
            persistence: .forSession
        )
        completionHandler(.useCredential, credential)
    }
}

// MARK: - Preview

#Preview("Pair with hub") {
    PairingView(
        hub: HubInfo(
            id: "scope.local:4321",
            name: "Bri's MacBook Pro",
            host: "scope.local",
            port: 4321,
            scheme: "https",
            caFingerprint: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            authMethods: ["mtls"]
        )
    )
    .environment(AppStore())
}
