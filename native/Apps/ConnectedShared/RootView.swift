import SimpleDocsConnected
import SimpleDocsOAuth
import SwiftUI

/// Signed-out states show the sign-in screen; a ready session shows the workspace.
struct RootView: View {
    @Bindable var model: ConnectedModel
    let actions: AppActions

    var body: some View {
        Group {
            if model.state == .ready {
                Workspace(session: model, actions: actions).id(model.sessionID)
            } else {
                SignInView(model: model)
            }
        }
        .task { model.restore() }
    }
}

/// One set of screen models per signed-in session; signing out or expiring rebuilds them.
struct Workspace: View {
    let session: ConnectedModel
    let actions: AppActions
    @State private var records: RecordsModel
    @State private var calls: CallsModel
    @State private var settings: SettingsModel
    @State private var send: SendModel
    @State private var openRecord: String?
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(session: ConnectedModel, actions: AppActions) {
        self.session = session
        self.actions = actions
        _records = State(initialValue: RecordsModel(session: session))
        _calls = State(initialValue: CallsModel(session: session))
        _settings = State(initialValue: SettingsModel(session: session))
        _send = State(initialValue: SendModel(session: session))
    }

    private var compact: Bool {
        #if os(iOS)
        sizeClass == .compact
        #else
        false
        #endif
    }

    var body: some View {
        Group {
            if compact { tabs } else { split }
        }
        .task { await registerForPush() }
        .onDisappear { PushCoordinator.shared.stop() }
        .onChange(of: actions.refreshTick) { Task { await refreshCurrent() } }
        .onChange(of: actions.newSendTick) { send.reset() }
    }

    /// Permission is requested only after sign-in. A failure here never affects the rest of the app.
    private func registerForPush() async {
        PushCoordinator.shared.onOpen = { actions.refresh() }
        await PushCoordinator.shared.start { token in
            let (platform, environment) = (PushCoordinator.platform.rawValue, PushCoordinator.environment.rawValue)
            try? await session.call { try await $0.registerPushDevice(token: token, platform: platform, environment: environment) }
        }
    }

    private func refreshCurrent() async {
        switch actions.area {
        case .records: await records.load()
        case .calls: await calls.load()
        case .settings: await settings.load()
        case .send: break
        }
    }

    private var split: some View {
        NavigationSplitView {
            List(Area.allCases, selection: Binding(get: { actions.area }, set: { if let value = $0 { actions.area = value } })) { area in
                Label(area.title, systemImage: area.symbol)
                    .badge(area == .calls ? calls.newCount : 0)
                    .tag(area)
            }
            .navigationTitle("simpledocs")
            #if os(macOS)
            .navigationSplitViewColumnWidth(min: 170, ideal: 200)
            #endif
        } detail: {
            screen(actions.area)
        }
    }

    private var tabs: some View {
        TabView(selection: Binding(get: { actions.area }, set: { actions.area = $0 })) {
            ForEach(Area.allCases) { area in
                screen(area)
                    .tabItem { Label(area.title, systemImage: area.symbol) }
                    .badge(area == .calls ? calls.newCount : 0)
                    .tag(area)
            }
        }
    }

    @ViewBuilder private func screen(_ area: Area) -> some View {
        switch area {
        case .send: NavigationStack { SendView(model: send, open: { id in openRecord = id; actions.area = .records }) }
        case .records: RecordsView(model: records, session: session, opening: $openRecord)
        case .calls: NavigationStack { CallsView(model: calls) }
        case .settings: NavigationStack { SettingsView(model: settings, session: session) }
        }
    }
}
