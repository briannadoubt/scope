import Foundation
import Network
import Observation

// MARK: - HubInfo

/// Describes a discovered Scope hub on the local network.
struct HubInfo: Identifiable, Equatable, Hashable {
    /// Stable identity derived from the resolved host and port.
    let id: String          // "\(host):\(port)"
    /// Human-readable Bonjour service name (e.g. "Bri's Mac").
    let name: String
    /// Resolved hostname or IP address.
    let host: String
    let port: Int
    /// "https" or "http" — sourced from the TXT record `scheme` key.
    let scheme: String
    /// SHA-256 hex fingerprint of the hub's self-signed CA, from TXT record `ca_fp`.
    let caFingerprint: String?
    /// Supported authentication methods, from TXT record `auth` (comma-separated).
    let authMethods: [String]

    var baseURL: URL {
        URL(string: "\(scheme)://\(host):\(port)")!
    }
}

// MARK: - HubDiscovery

/// Scans the local network for `_scope._tcp.` Bonjour services and publishes
/// the results as an array of `HubInfo` values.
///
/// Lifecycle: scanning starts automatically on init and can be stopped/restarted
/// via `stopScanning()` / `startScanning()`.  Call `stopScanning()` when the
/// owning view disappears to release the underlying `NWBrowser`.
@Observable
@MainActor
final class HubDiscovery {

    // MARK: Published state

    /// Live list of currently visible hubs, keyed by `HubInfo.id`.
    private(set) var discovered: [HubInfo] = []
    /// `true` while the `NWBrowser` is running.
    private(set) var isScanning: Bool = false

    // MARK: Private state

    private var browser: NWBrowser?

    // MARK: Init

    init() {
        startScanning()
    }

    // MARK: Public API

    /// Starts (or restarts) Bonjour discovery for `_scope._tcp.`.
    func startScanning() {
        guard browser == nil else { return }

        let params = NWParameters.tcp
        // Allow link-local / mDNS traffic on all interfaces.
        params.includePeerToPeer = true

        let newBrowser = NWBrowser(
            for: .bonjourWithTXTRecord(type: "_scope._tcp.", domain: nil),
            using: params
        )

        newBrowser.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            Task { @MainActor in
                switch state {
                case .ready:
                    self.isScanning = true
                case .cancelled, .failed:
                    self.isScanning = false
                    self.browser = nil
                default:
                    break
                }
            }
        }

        newBrowser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            Task { @MainActor in
                self.applyResults(results)
            }
        }

        newBrowser.start(queue: .main)
        browser = newBrowser
        isScanning = true
    }

    /// Stops Bonjour discovery and clears the discovered list.
    func stopScanning() {
        browser?.cancel()
        browser = nil
        isScanning = false
        discovered = []
    }

    // MARK: Private helpers

    /// Replaces the published `discovered` array with hubs parsed from the
    /// current browser result set.
    private func applyResults(_ results: Set<NWBrowser.Result>) {
        var hubs: [HubInfo] = []
        for result in results {
            if let hub = hubInfo(from: result) {
                hubs.append(hub)
            }
        }
        // Stable sort: HTTPS first, then alphabetically by name.
        hubs.sort {
            if $0.scheme != $1.scheme { return $0.scheme > $1.scheme }
            return $0.name < $1.name
        }
        discovered = hubs
    }

    /// Converts a single `NWBrowser.Result` into a `HubInfo`, or `nil` if the
    /// endpoint is not a named Bonjour service.
    private func hubInfo(from result: NWBrowser.Result) -> HubInfo? {
        // We only handle .service endpoints; ignore everything else.
        guard case let .service(name, _, _, _) = result.endpoint else {
            return nil
        }

        // ── TXT record parsing ──────────────────────────────────────────────
        var scheme: String = "http"
        var caFingerprint: String? = nil
        var authMethods: [String] = []
        var txtHost: String? = nil
        var txtPort: Int? = nil

        if case let .bonjour(txtRecord) = result.metadata {
            let dict = txtRecord.dictionary   // [String: String]

            // `scheme` key → "https" or "http"
            if let value = dict["scheme"] {
                scheme = value.lowercased()
            }
            // `ca_fp` key → hex fingerprint string
            if let value = dict["ca_fp"], !value.isEmpty {
                caFingerprint = value
            }
            // `auth` key → comma-separated list of method names
            if let value = dict["auth"] {
                authMethods = value
                    .split(separator: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces) }
                    .filter { !$0.isEmpty }
            }
            // `host` / `port` keys → real SRV target (NWBrowser doesn't expose
            // SRV resolution without a full NWConnection.start()).
            if let value = dict["host"], !value.isEmpty {
                txtHost = value
            }
            if let value = dict["port"], let parsed = Int(value) {
                txtPort = parsed
            }
        }

        // ── Host / port resolution ──────────────────────────────────────────
        //
        // Preferred path: read host + port from the TXT record (the hub
        // duplicates its SRV target there).
        //
        // Legacy fallback: if the service name is itself "hostname:port"
        // (older hubs registered services this way), parse it as such; else
        // use the raw service name + default port for the scheme.

        let host: String
        let port: Int
        if let txtHost, let txtPort {
            host = txtHost
            port = txtPort
        } else {
            (host, port) = parseHostPort(from: name, defaultPort: scheme == "https" ? 443 : 80)
        }

        return HubInfo(
            id: "\(host):\(port)",
            name: name,
            host: host,
            port: port,
            scheme: scheme,
            caFingerprint: caFingerprint,
            authMethods: authMethods
        )
    }

    /// Splits a string of the form `"hostname:port"` into its components.
    /// Falls back to the raw string as hostname + `defaultPort` when there is
    /// no colon, or when the port segment is not a valid integer.
    private func parseHostPort(from raw: String, defaultPort: Int) -> (String, Int) {
        // Handle IPv6 bracketed addresses: "[::1]:8443"
        if raw.hasPrefix("[") {
            if let closingBracket = raw.firstIndex(of: "]") {
                let host = String(raw[raw.index(after: raw.startIndex)..<closingBracket])
                let afterBracket = raw.index(after: closingBracket)
                if afterBracket < raw.endIndex, raw[afterBracket] == ":" {
                    let portString = String(raw[raw.index(after: afterBracket)...])
                    if let port = Int(portString) {
                        return (host, port)
                    }
                }
                return (host, defaultPort)
            }
        }

        // Plain hostname or hostname:port
        if let colonIdx = raw.lastIndex(of: ":") {
            let host = String(raw[raw.startIndex..<colonIdx])
            let portString = String(raw[raw.index(after: colonIdx)...])
            if let port = Int(portString), !host.isEmpty {
                return (host, port)
            }
        }

        return (raw, defaultPort)
    }
}
