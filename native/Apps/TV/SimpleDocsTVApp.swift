import SwiftUI

@main
struct SimpleDocsTVApp: App {
    @State private var session = TVSession()

    var body: some Scene {
        WindowGroup {
            TVRootView(session: session)
        }
    }
}
