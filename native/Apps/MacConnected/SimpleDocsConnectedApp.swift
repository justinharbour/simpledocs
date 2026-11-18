import SwiftUI

@main
struct SimpleDocsConnectedApp: App {
    @NSApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @State private var environment = ConnectedEnvironment()

    var body: some Scene {
        WindowGroup {
            ConnectedRoot(environment: environment)
                .frame(minWidth: 760, minHeight: 520)
        }
        .commands { ConnectedCommands(environment: environment) }
    }
}
