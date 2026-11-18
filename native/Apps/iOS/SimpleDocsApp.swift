import SwiftUI

@main
struct SimpleDocsApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    var body: some Scene {
        WindowGroup {
            ConnectedSignInView()
        }
    }
}
