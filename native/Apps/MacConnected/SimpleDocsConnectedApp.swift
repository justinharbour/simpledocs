import SwiftUI

@main
struct SimpleDocsConnectedApp: App {
    var body: some Scene {
        WindowGroup {
            ConnectedSignInView()
                .frame(minWidth: 720, minHeight: 480)
        }
        .commands { SidebarCommands() }
    }
}
