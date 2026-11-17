import SimpleDocsCore
import SimpleDocsViews
import SwiftUI

@main
struct SimpleDocsOwnerApp: App {
    @State private var model = WorkspaceModel(edition: .ownerBackend)

    var body: some Scene {
        WindowGroup {
            WorkspaceView(model: model)
                .frame(minWidth: 720, minHeight: 480)
        }
        .commands { SidebarCommands() }
    }
}
