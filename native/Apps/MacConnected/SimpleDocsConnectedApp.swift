import SwiftUI

@main
struct SimpleDocsConnectedApp: App {
    @NSApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    var body: some Scene {
        WindowGroup {
            ConnectedSignInView()
                .frame(minWidth: 720, minHeight: 480)
        }
        .commands { SidebarCommands() }
    }
}
