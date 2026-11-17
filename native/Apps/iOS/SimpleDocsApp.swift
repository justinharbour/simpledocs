import SimpleDocsCore
import SimpleDocsViews
import SwiftUI

@main
struct SimpleDocsApp: App {
    @State private var model = WorkspaceModel(edition: .ownerBackend)

    var body: some Scene {
        WindowGroup {
            WorkspaceView(model: model)
        }
    }
}
