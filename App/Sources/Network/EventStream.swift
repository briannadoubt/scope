import Foundation

// MARK: - SSEEvent

enum SSEEvent {
    case ticketUpdated(Ticket)
    case ticketCreated(Ticket)
    case ticketDeleted(String)
    /// A cross-ticket relation was added or removed. Carries no payload — the
    /// hub emits `relation.added`/`relation.removed` without touching the
    /// ticket list, so listeners (the flow graph) just re-fetch relations.
    case relationsChanged
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
    /// The underlying URLSession whose delegate configuration (mTLS credentials,
    /// pinned trust etc.) matches the one used by HubClient.
    private let sourceSession: URLSession

    /// Dedicated session wired to our private delegate helper.
    private var streamSession: URLSession?
    private var dataTask: URLSessionDataTask?
    private var currentWorkspaceId: String?
    private var buffer: String = ""
    private var reconnectTask: Task<Void, Never>?
    private var stopped: Bool = false

    // MARK: Init

    /// - Parameters:
    ///   - baseURL: The hub base URL (same one used by `HubClient`).
    ///   - session: The `URLSession` to inherit configuration from (mTLS delegate, etc.).
    ///              A new session sharing the same `configuration` is created for streaming.
    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
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
        dataTask?.cancel()
        dataTask = nil
        streamSession?.invalidateAndCancel()
        streamSession = nil
        isConnected = false
    }

    // MARK: - Internal

    private func openStream() {
        // Cancel any previous task / session.
        dataTask?.cancel()
        streamSession?.invalidateAndCancel()
        buffer = ""

        // Build the request.
        var components = URLComponents(
            url: baseURL.appendingPathComponent("/events"),
            resolvingAgainstBaseURL: false
        )!
        if let wsId = currentWorkspaceId {
            components.queryItems = [URLQueryItem(name: "workspace", value: wsId)]
        }
        guard let url = components.url else { return }

        var request = URLRequest(url: url)
        request.timeoutInterval = 0       // no timeout — stream is long-lived
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache",          forHTTPHeaderField: "Cache-Control")
        // mTLS authentication is handled by the URLSession delegate configuration
        // inherited from the hub's session; no bearer token is required.

        // Create a new session using the same configuration so mTLS creds are
        // inherited, but with our private delegate to receive incremental data.
        let helper = StreamDelegate(stream: self)
        let session = URLSession(
            configuration: sourceSession.configuration,
            delegate: helper,
            delegateQueue: nil       // serial background queue, URLSession default
        )
        streamSession = session

        let task = session.dataTask(with: request)
        dataTask = task
        task.resume()
    }

    // MARK: - SSE parsing

    /// Process a complete SSE frame (everything between double-newlines).
    fileprivate func processFrame(_ frame: String) {
        var eventName = ""
        var dataLines: [String] = []

        for line in frame.components(separatedBy: "\n") {
            if line.hasPrefix("event:") {
                eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            }
            // Lines starting with ":" are SSE comments (keepalive); ignore.
        }

        guard eventName == "change", !dataLines.isEmpty else { return }

        let jsonString = dataLines.joined(separator: "\n")
        guard
            let jsonData = jsonString.data(using: .utf8),
            let raw = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
            let type = raw["type"] as? String
        else { return }

        switch type {
        case "ticket.updated", "ticket.created":
            guard
                let ticketObj = raw["ticket"],
                let ticketData = try? JSONSerialization.data(withJSONObject: ticketObj),
                let ticket = try? HubClient.decoder.decode(Ticket.self, from: ticketData)
            else { return }
            let event: SSEEvent = (type == "ticket.created")
                ? .ticketCreated(ticket)
                : .ticketUpdated(ticket)
            onEvent?(event)

        case "ticket.deleted":
            guard let ticketId = raw["ticketId"] as? String else { return }
            onEvent?(.ticketDeleted(ticketId))

        case "relation.added", "relation.removed":
            onEvent?(.relationsChanged)

        default:
            break
        }
    }

    // MARK: - Reconnect

    fileprivate func handleDisconnect() {
        isConnected = false
        guard !stopped else { return }
        scheduleReconnect()
    }

    fileprivate func handleConnected() {
        isConnected = true
    }

    fileprivate func appendBuffer(_ text: String) {
        buffer += text
        // Split on the SSE frame separator.
        let frames = buffer.components(separatedBy: "\n\n")
        // Keep the last (possibly incomplete) chunk in the buffer.
        buffer = frames.last ?? ""
        for frame in frames.dropLast() {
            let trimmed = frame.trimmingCharacters(in: .newlines)
            guard !trimmed.isEmpty else { continue }
            processFrame(trimmed)
        }
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

// MARK: - Private delegate helper
//
// NSObject subclass that receives URLSession callbacks on a background thread
// and hops to the MainActor to call back into EventStream.

private final class StreamDelegate: NSObject, URLSessionDataDelegate {

    private weak var stream: EventStream?

    init(stream: EventStream) {
        self.stream = stream
    }

    func urlSession(_ session: URLSession,
                    dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        completionHandler(.allow)
        Task { @MainActor [weak stream] in
            stream?.handleConnected()
        }
    }

    func urlSession(_ session: URLSession,
                    dataTask: URLSessionDataTask,
                    didReceive data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        Task { @MainActor [weak stream] in
            stream?.appendBuffer(text)
        }
    }

    func urlSession(_ session: URLSession,
                    task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        Task { @MainActor [weak stream] in
            stream?.handleDisconnect()
        }
    }
}
