import CryptoKit
import Foundation
import Security

// MARK: - HubClientError

enum HubClientError: LocalizedError {
    case badStatus(Int, Data)
    case noData
    /// Network is unreachable — surfaced by `AppStore` write methods before
    /// even attempting the HTTP request, so we don't sit on a long URLSession
    /// timeout. The UI shows this verbatim in the error banner.
    case offline

    var errorDescription: String? {
        switch self {
        case .badStatus(let code, let data):
            let body = String(data: data, encoding: .utf8) ?? "<binary>"
            return "HTTP \(code): \(body)"
        case .noData:
            return "Server returned no data"
        case .offline:
            return "You're offline. Try again when the network returns."
        }
    }
}

// MARK: - HubTrustDelegate

/// Handles server-trust challenges for hub HTTPS connections.
///
/// Policy:
/// - If a CA fingerprint is pinned, the server's CA cert (or leaf, for self-signed
///   issuers) must match before the connection proceeds.
/// - If no fingerprint is configured, any server cert is accepted
///   (trust-on-first-use for local hubs that haven't been paired yet).
private final class HubTrustDelegate: NSObject, URLSessionDelegate {

    var caFingerprint: String?

    init(caFingerprint: String? = nil) {
        self.caFingerprint = caFingerprint
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        guard let fingerprint = caFingerprint else {
            // No pinned fingerprint — accept any cert (TOFU for local-network hubs).
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
            return
        }

        guard let chainRef = SecTrustCopyCertificateChain(serverTrust) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        // CFArray elements are always SecCertificate here — forced cast is correct.
        let chain = chainRef as! [SecCertificate]
        guard let leafCert = chain.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        let normalizedPin = fingerprint.lowercased().replacingOccurrences(of: ":", with: "")

        // Check both the leaf cert and (if chain length > 1) the CA/root cert.
        let certsToCheck = chain.count > 1 ? [leafCert, chain[chain.count - 1]] : [leafCert]
        for cert in certsToCheck {
            let certData = SecCertificateCopyData(cert) as Data
            let hash = SHA256.hash(data: certData)
            let hex = hash.compactMap { String(format: "%02x", $0) }.joined()
            if hex == normalizedPin {
                completionHandler(.useCredential, URLCredential(trust: serverTrust))
                return
            }
        }

        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}

// MARK: - HubClient

@Observable
@MainActor
final class HubClient {
    var baseURL: URL
    var workspaceId: String?
    var token: String?
    /// Optional SHA-256 hex fingerprint of the hub's CA cert for TLS pinning.
    var caFingerprint: String? {
        didSet { trustDelegate.caFingerprint = caFingerprint }
    }
    private(set) var isConnected: Bool = false

    private let session: URLSession
    private let trustDelegate: HubTrustDelegate

    // MARK: - Shared coder instances

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        // Try fractional-seconds first, fall back to whole-seconds.
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        d.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let str = try container.decode(String.self)
            if let date = fractional.date(from: str) { return date }
            if let date = plain.date(from: str)       { return date }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot parse date: \(str)"
            )
        }
        return d
    }()

    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        e.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(fmt.string(from: date))
        }
        return e
    }()

    // MARK: - Init

    /// - Parameters:
    ///   - baseURL: Hub base URL (e.g. `https://10.0.0.83:4321`).
    ///   - workspaceId: Workspace query parameter added to every request.
    ///   - token: Bearer token for `Authorization` header.
    ///   - caFingerprint: SHA-256 hex fingerprint of the hub's CA cert. When set,
    ///     TLS pinning is enforced. When `nil`, any cert is accepted (TOFU).
    ///   - session: Override for unit testing. When `nil`, a fresh ephemeral
    ///     session with `HubTrustDelegate` is created automatically.
    init(
        baseURL: URL,
        workspaceId: String? = nil,
        token: String? = nil,
        caFingerprint: String? = nil,
        session: URLSession? = nil
    ) {
        self.baseURL = baseURL
        self.workspaceId = workspaceId
        self.token = token
        self.caFingerprint = caFingerprint

        let delegate = HubTrustDelegate(caFingerprint: caFingerprint)
        self.trustDelegate = delegate
        self.session = session ?? URLSession(
            configuration: .ephemeral,
            delegate: delegate,
            delegateQueue: nil
        )
    }

    // MARK: - URL building

    private func url(for path: String, query: [URLQueryItem] = []) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        var items = components.queryItems ?? []
        items.append(contentsOf: query)
        if let wsId = workspaceId {
            items.append(URLQueryItem(name: "workspace", value: wsId))
        }
        // `appendingPathComponent` percent-encodes "?" into the path, so query
        // strings must be passed via `query:` (not baked into `path`) to land
        // as real query items here.
        components.queryItems = items.isEmpty ? nil : items
        return components.url!
    }

    private func request(method: String, path: String, query: [URLQueryItem] = [], body: Data?) -> URLRequest {
        var req = URLRequest(url: url(for: path, query: query))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    // MARK: - Core execute

    private func execute(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw HubClientError.noData }
        guard (200..<300).contains(http.statusCode) else {
            throw HubClientError.badStatus(http.statusCode, data)
        }
        isConnected = true
        return data
    }

    // MARK: - Generic HTTP verbs

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        let req = request(method: "GET", path: path, query: query, body: nil)
        let data = try await execute(req)
        return try Self.decoder.decode(T.self, from: data)
    }

    func post<T: Decodable>(_ path: String, body: some Encodable) async throws -> T {
        let bodyData = try Self.encoder.encode(body)
        let req = request(method: "POST", path: path, body: bodyData)
        let data = try await execute(req)
        return try Self.decoder.decode(T.self, from: data)
    }

    func patch<T: Decodable>(_ path: String, body: some Encodable) async throws -> T {
        let bodyData = try Self.encoder.encode(body)
        let req = request(method: "PATCH", path: path, body: bodyData)
        let data = try await execute(req)
        return try Self.decoder.decode(T.self, from: data)
    }

    /// PATCH variant that accepts raw JSON data (used for `TicketUpdate` sparse patches).
    func patchRaw<T: Decodable>(_ path: String, bodyData: Data) async throws -> T {
        let req = request(method: "PATCH", path: path, body: bodyData)
        let data = try await execute(req)
        return try Self.decoder.decode(T.self, from: data)
    }

    func postEmpty(_ path: String) async throws -> Data {
        let req = request(method: "POST", path: path, body: nil)
        return try await execute(req)
    }

    func delete(_ path: String) async throws {
        let req = request(method: "DELETE", path: path, body: nil)
        _ = try await execute(req)
    }

    // MARK: - Connectivity check

    /// Fires a lightweight GET /api/meta to verify the connection.
    func checkConnectivity() async {
        do {
            let _: [String: String] = try await get("/api/meta")
            isConnected = true
        } catch {
            isConnected = false
        }
    }
}
