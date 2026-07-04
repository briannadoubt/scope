import Foundation

// MARK: - SSEEvent

enum SSEEvent: Equatable {
    case connected
    /// The hub only promises a coarse change envelope over SSE. Treat ticket,
    /// sync, remote-pull, fs-watch, and comment events as a signal to refresh
    /// the canonical `/api/tickets` snapshot.
    case ticketsChanged
    /// A cross-ticket relation was added or removed. Carries no payload; graph
    /// listeners re-fetch relations, while the board can ignore it.
    case relationsChanged
}

// MARK: - SSEFrameParser

enum SSEFrameParser {
    static func event(from frame: String) -> SSEEvent? {
        var eventName = ""
        var dataLines: [String] = []

        for line in frame.components(separatedBy: "\n") {
            if line.hasPrefix("event:") {
                eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            }
        }

        guard eventName == "change", !dataLines.isEmpty else { return nil }

        let jsonString = dataLines.joined(separator: "\n")
        guard
            let jsonData = jsonString.data(using: .utf8),
            let raw = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
            let type = raw["type"] as? String
        else { return nil }

        switch type {
        case "presence":
            return nil
        case "relation.added", "relation.removed":
            return .relationsChanged
        default:
            return .ticketsChanged
        }
    }
}

// MARK: - EventStream

/// Connects to the hub's `/events` SSE endpoint and dispatches decoded events
/// on the main actor.  Reconnects automatically after a 2-second delay on
/// any disconnect or error.
@Observable @MainActor
final class EventStream {

    // MARK: Public state

    var onEvent: ((SSEEvent) -> Void)?
    private(set) var isConnected: Bool = false

    // MARK: Private

    private let baseURL: URL
    private let token: String?
    /// The underlying URLSession whose delegate configuration (mTLS credentials,
    /// pinned trust etc.) matches the one used by HubClient.
    private let sourceSession: URLSession

    private var streamTask: Task<Void, Never>?
    private var currentWorkspaceId: String?
    private var reconnectTask: Task<Void, Never>?
    private var stopped: Bool = false

    // MARK: Init

    /// - Parameters:
    ///   - baseURL: The hub base URL (same one used by `HubClient`).
    ///   - token: Optional bearer token. Must mirror `HubClient` so hosted hubs
    ///            authorize live events the same way they authorize REST.
    ///   - session: The `URLSession` to inherit configuration from (mTLS delegate, etc.).
    init(baseURL: URL, token: String? = nil, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.token = token
        self.sourceSession = session
    }

    // MARK: - Connect / Disconnect

    func connect(workspaceId: String?) {
        stopped = false
        currentWorkspaceId = workspaceId
        openStream()
    }

    func disconnect() {
        stopped = true
        reconnectTask?.cancel()
        reconnectTask = nil
        streamTask?.cancel()
        streamTask = nil
        isConnected = false
    }

    // MARK: - Internal

    private func openStream() {
        streamTask?.cancel()
        streamTask = nil

        let request = request(workspaceId: currentWorkspaceId)
        let session = sourceSession

        streamTask = Task { [weak self] in
            do {
                let (bytes, _) = try await session.bytes(for: request)
                await MainActor.run { self?.handleConnected() }

                var frameLines: [String] = []
                for try await line in bytes.lines {
                    if Task.isCancelled { return }
                    if line.isEmpty {
                        let frame = frameLines.joined(separator: "\n")
                        frameLines.removeAll()
                        await MainActor.run { self?.processFrame(frame) }
                    } else {
                        frameLines.append(line)
                    }
                }
            } catch {
                // Reconnect below.
            }

            await MainActor.run { self?.handleDisconnect() }
        }
    }

    func request(workspaceId: String?) -> URLRequest {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("events"),
            resolvingAgainstBaseURL: false
        )!
        if let wsId = workspaceId {
            components.queryItems = [URLQueryItem(name: "workspace", value: wsId)]
        }

        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 0       // no timeout — stream is long-lived
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache",          forHTTPHeaderField: "Cache-Control")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    // MARK: - SSE parsing

    /// Process a complete SSE frame (everything between double-newlines).
    fileprivate func processFrame(_ frame: String) {
        guard let event = SSEFrameParser.event(from: frame) else { return }
        onEvent?(event)
    }

    // MARK: - Reconnect

    fileprivate func handleDisconnect() {
        isConnected = false
        guard !stopped else { return }
        scheduleReconnect()
    }

    fileprivate func handleConnected() {
        isConnected = true
        onEvent?(.connected)
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard let self, !self.stopped else { return }
            self.openStream()
        }
    }
}
