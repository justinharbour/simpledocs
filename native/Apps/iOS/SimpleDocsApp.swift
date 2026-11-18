import SwiftUI

@main
struct SimpleDocsApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @State private var environment = ConnectedEnvironment()

    var body: some Scene {
        WindowGroup {
            ConnectedRoot(environment: environment)
        }
    }
}
