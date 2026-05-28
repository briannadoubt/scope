import SwiftUI

/// Thin top-of-screen banner that appears when `NWPathMonitor` reports the
/// network has gone away. Mirrors the web UI's grey live-dot indicator —
/// every screen that shows the banner makes it obvious why writes are
/// failing and why the board isn't updating in realtime.
///
/// The banner does *not* push other content down — it overlays the top
/// edge as a thin strip so the rest of the layout stays stable. When
/// connectivity returns it slides up off-screen.
struct OfflineBanner: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        // Don't flash "Offline" during the ~100ms NWPathMonitor takes to
        // produce its first reading on a cold launch.
        if store.netMonitor.hasInitialState, !store.isOnline {
            HStack(spacing: 8) {
                Image(systemName: "wifi.slash")
                    .imageScale(.small)
                Text("Offline — reconnecting…")
                    .font(.footnote.weight(.medium))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(Color.orange.opacity(0.92))
            .foregroundStyle(.white)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

#Preview("Offline") {
    let store = AppStore()
    return VStack(spacing: 0) {
        OfflineBanner()
        Spacer()
    }
    .environment(store)
}
