import SwiftUI

@main
struct ScopeApp: App {
    @State private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .task {
                    if await applyUITestEnvironmentIfNeeded() == false {
                        await store.restoreSavedConnection()
                    }
                }
        }
    }

    /// DEBUG-only launch hook so headless tooling (e.g. xcodebuildmcp's
    /// `launch_app_sim`) can drive the app to a connected screen without the
    /// pairing / manual-entry taps that computer-use would otherwise perform.
    /// Activated only when `UITEST_HUB_URL` is present in the environment, e.g.:
    ///   env = { UITEST_HUB_URL, UITEST_HUB_TOKEN, UITEST_WORKSPACE, UITEST_VIEW }
    @discardableResult
    private func applyUITestEnvironmentIfNeeded() async -> Bool {
        #if DEBUG
        let env = ProcessInfo.processInfo.environment
        guard let urlString = env["UITEST_HUB_URL"],
              let url = URL(string: urlString) else { return false }
        await store.connect(to: url, token: env["UITEST_HUB_TOKEN"])
        if let wsId = env["UITEST_WORKSPACE"],
           let ws = store.workspaces.first(where: { $0.id == wsId }) {
            store.selectedWorkspace = ws
        }
        return true
        #else
        return false
        #endif
    }
}
