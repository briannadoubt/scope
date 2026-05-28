import Foundation
import Network

/// Observes overall network reachability and republishes it as a SwiftUI-
/// observable `isOnline` flag. Wraps `NWPathMonitor` so views can react via
/// the Observation framework without each having to spin up their own
/// monitor + delegate plumbing.
///
/// Lifecycle: `start()` once at app launch, `stop()` on teardown. The first
/// `isOnline` value is the live answer from `NWPathMonitor` — we don't
/// optimistically assume reachable until we hear otherwise, because a fresh
/// monitor can report `.unsatisfied` for the first ~100ms during evaluation,
/// and a banner that flashes "Offline" on every launch is worse than a small
/// delay before "Online" appears.
@Observable
@MainActor
final class NetworkPathMonitor {
    /// `true` when at least one network interface is reporting a satisfied
    /// path. Drives the offline banner in `RootView` and short-circuits
    /// `AppStore`'s write methods to avoid sitting on a long URLSession
    /// timeout that the user would otherwise feel as the app hanging.
    private(set) var isOnline: Bool = true

    /// Whether the monitor has received any path update yet. Used by the
    /// banner to suppress its initial state until we actually know.
    private(set) var hasInitialState: Bool = false

    /// Called once per transition (online → offline or offline → online).
    /// `AppStore` uses this to refresh tickets + reconnect SSE on the
    /// online edge — the system already auto-reconnects URLSession, but
    /// any tickets that mutated while we were offline would otherwise stay
    /// stale until the next manual refresh.
    var onTransition: ((Bool) -> Void)?

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.briannadoubt.scope.network-monitor")
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor [weak self] in
                guard let self else { return }
                let was = self.isOnline
                self.isOnline = online
                if !self.hasInitialState {
                    self.hasInitialState = true
                } else if was != online {
                    self.onTransition?(online)
                }
            }
        }
        monitor.start(queue: queue)
    }

    func stop() {
        monitor.cancel()
        started = false
    }

    deinit {
        // `NWPathMonitor.cancel()` is safe to call from any thread.
        monitor.cancel()
    }
}
