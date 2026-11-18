import SimpleDocsOAuth
import SwiftUI

/// Owns the sign-in model and navigation actions so the app entry points stay free of package imports.
@MainActor @Observable final class ConnectedEnvironment {
    let model = ConnectedModel(anchor: AppAnchor())
    let actions = AppActions()
}

struct ConnectedRoot: View {
    let environment: ConnectedEnvironment

    var body: some View {
        RootView(model: environment.model, actions: environment.actions)
    }
}

#if os(macOS)
struct ConnectedCommands: Commands {
    let environment: ConnectedEnvironment

    var body: some Commands {
        SidebarCommands()
        CommandGroup(replacing: .newItem) {
            Button("New Send") { environment.actions.newSend() }
                .keyboardShortcut("n")
                .disabled(environment.model.state != .ready)
        }
        CommandGroup(after: .toolbar) {
            Button("Refresh") { environment.actions.refresh() }
                .keyboardShortcut("r")
                .disabled(environment.model.state != .ready)
        }
    }
}
#endif
