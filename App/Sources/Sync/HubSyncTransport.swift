import CryptoKit
import Foundation
import Security

// MARK: - HubSyncTransport (SCP-135)
//
// Adapts the hub's sync endpoints to the `SyncTransport` protocol the engine
// consumes. It does NOT reuse `HubClient.get/post` because those are wired to
// `HubClient.encoder/decoder`, which apply `.convertToSnakeCase` and WOULD
// CORRUPT the camelCase event payloads (`ticketId`, `keyPrefix`, ...). Instead
// it issues its own requests and uses `SyncWire.coder` (verbatim keys).
//
// Connection parameters (baseURL, workspace, token, CA fingerprint) are read
// from a `HubClient` so wiring stays in one place; see the integration notes
// for how `AppStore` constructs this from its existing `client`.
//
// PREFERRED ALTERNATIVE (smaller, but requires a one-line edit to HubClient):
// expose a `func sync<T: Decodable>(...)` on HubClient that reuses its private
// `session`/trust delegate but takes the verbatim coder. The HARD RULES for
// this ticket forbid editing existing files, so this self-contained transport
// is delivered instead and the edit is flagged in the integration notes.

final class HubSyncTransport: SyncTransport, @unchecked Sendable {

    enum TransportError: LocalizedError {
        case badStatus(Int, Data)
        case notHTTP
        var errorDescription: String? {
            switch self {
            case .badStatus(let code, let data):
                return "Sync HTTP \(code): \(String(data: data, encoding: .utf8) ?? "<binary>")"
            case .notHTTP:
                return "Sync: non-HTTP response"
            }
        }
    }

    private let baseURL: URL
    private let workspaceId: String?
    private let token: String?
    private let session: URLSession
    private let trustDelegate: SyncTrustDelegate
    private let coder = SyncWire.coder

    /// - Parameters mirror the connection state held by `HubClient`. Pass the
    ///   live values from `appStore.client` (see integration notes).
    init(baseURL: URL, workspaceId: String?, token: String?, caFingerprint: String?) {
        self.baseURL = baseURL
        self.workspaceId = workspaceId
        self.token = token
        let delegate = SyncTrustDelegate(caFingerprint: caFingerprint)
        self.trustDelegate = delegate
        self.session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
    }

    // MARK: SyncTransport

    func pull(since cursor: String?, limit: Int) async throws -> PullResponse {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { query.append(URLQueryItem(name: "since", value: cursor)) }
        let req = request(method: "GET", path: "/api/sync/pull", query: query, body: nil)
        let data = try await execute(req)
        return try coder.decoder.decode(PullResponse.self, from: data)
    }

    func push(_ events: [SyncEvent]) async throws -> PushResponse {
        let body = try coder.encoder.encode(PushRequest(events: events))
        let req = request(method: "POST", path: "/api/sync/push", query: [], body: body)
        let data = try await execute(req)
        return try coder.decoder.decode(PushResponse.self, from: data)
    }

    // MARK: Plumbing (mirrors HubClient)

    private func url(for path: String, query: [URLQueryItem]) -> URL {
        var components = URLComponents(
            url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        var items = query
        if let workspaceId {
            items.append(URLQueryItem(name: "workspace", value: workspaceId))
        }
        components.queryItems = items.isEmpty ? nil : items
        return components.url!
    }

    private func request(method: String, path: String, query: [URLQueryItem], body: Data?) -> URLRequest {
        var req = URLRequest(url: url(for: path, query: query))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return req
    }

    private func execute(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw TransportError.notHTTP }
        guard (200..<300).contains(http.statusCode) else {
            throw TransportError.badStatus(http.statusCode, data)
        }
        return data
    }
}

// MARK: - Trust delegate
//
// Same TOFU-or-pinned policy as `HubClient`'s private `HubTrustDelegate`
// (which is `private` and so can't be reused). Duplicated minimally here.

private final class SyncTrustDelegate: NSObject, URLSessionDelegate {
    let caFingerprint: String?
    init(caFingerprint: String?) { self.caFingerprint = caFingerprint }

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
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
            return
        }
        guard let chainRef = SecTrustCopyCertificateChain(serverTrust) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let chain = chainRef as! [SecCertificate]
        guard let leaf = chain.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let pin = fingerprint.lowercased().replacingOccurrences(of: ":", with: "")
        let certs = chain.count > 1 ? [leaf, chain[chain.count - 1]] : [leaf]
        for cert in certs {
            let der = SecCertificateCopyData(cert) as Data
            let hex = SHA256.hash(data: der).compactMap { String(format: "%02x", $0) }.joined()
            if hex == pin {
                completionHandler(.useCredential, URLCredential(trust: serverTrust))
                return
            }
        }
        completionHandler(.cancelAuthenticationChallenge, nil)
    }
}
