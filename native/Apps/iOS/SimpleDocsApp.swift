import SimpleDocsCore
import SimpleDocsViews
import SwiftUI

@main
struct SimpleDocsApp: App {
    @State private var model = WorkspaceModel(edition: .connectedInstance)

    var body: some Scene {
        WindowGroup {
            TabView {
                WorkspaceView(model: model).tabItem { Label("Sample workspace", systemImage: "doc.text") }
                ConnectedSignInView().tabItem { Label("Sign in", systemImage: "person.crop.circle") }
            }
        }
    }
}
