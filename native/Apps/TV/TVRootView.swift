import SwiftUI
import UIKit

struct TVRootView: View {
    let session: TVSession

    var body: some View {
        Group {
            if session.token == nil {
                TVPairingView(session: session)
            } else {
                TVHomeView(session: session)
            }
        }
        .task(id: session.token) {
            if session.token == nil { await session.runPairing() }
        }
    }
}

struct TVPairingView: View {
    let session: TVSession

    var body: some View {
        VStack(spacing: 40) {
            Text("Pair this Apple TV").font(.largeTitle.bold())
            if let code = session.pairing {
                Text(code.userCode).font(.system(size: 120, weight: .semibold, design: .monospaced)).kerning(8)
                Text("https://simpledocs.justinharbour.com/settings").font(.title2)
            } else {
                ProgressView()
            }
        }
        .padding(80)
    }
}

struct TVHomeView: View {
    let session: TVSession
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            TVDashboardView(session: session)
        }
        .task(id: scenePhase) { await poll() }
    }

    private func poll() async {
        guard scenePhase == .active else { return }
        while !Task.isCancelled && scenePhase == .active {
            await session.refreshDashboard()
            try? await Task.sleep(for: .seconds(5))
        }
    }
}

struct TVDashboardView: View {
    let session: TVSession

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                if (session.dashboard?.calls?.last24h.ringing ?? 0) > 0 {
                    Text("Incoming call").font(.title.bold()).padding(24).frame(maxWidth: .infinity)
                        .background(.green.opacity(0.3), in: RoundedRectangle(cornerRadius: 16))
                }
                if let dashboard = session.dashboard {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 300))], spacing: 24) {
                        tile("Phone", dashboard.phone.online ? "Online" : "Offline")
                        if let calls = dashboard.calls?.last24h {
                            tile("Answered, 24h", "\(calls.answered)")
                            tile("Missed, 24h", "\(calls.missed)")
                            tile("Voicemail, 24h", "\(calls.voicemail)")
                        }
                        if let inbox = dashboard.inbox {
                            tile("Unread faxes", "\(inbox.unreadFax)")
                            tile("Unread voicemail", "\(inbox.unreadVoicemail)")
                        }
                        tile("Pending approvals", "\(dashboard.pendingApprovals)")
                    }
                    if !dashboard.recentSends.isEmpty {
                        Text("Recent sends").font(.title2.bold())
                        ForEach(Array(dashboard.recentSends.enumerated()), id: \.offset) { _, send in
                            HStack {
                                Text(send.title).lineLimit(1)
                                Spacer()
                                Text(send.status)
                                Text(TVTime.short(send.createdAt)).foregroundStyle(.secondary)
                            }
                            .font(.title3)
                        }
                    }
                    Text("Updated \(TVTime.short(dashboard.generatedAt))").font(.callout).foregroundStyle(.secondary)
                }
                NavigationLink("History") { TVHistoryView(session: session) }
                if session.dashboardFailed {
                    Text("Could not refresh. Showing the last update.").font(.callout).foregroundStyle(.secondary)
                }
            }
            .padding(60)
        }
    }

    private func tile(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.title3).foregroundStyle(.secondary)
            Text(value).font(.system(size: 56, weight: .semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(24)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
    }
}

struct TVHistoryView: View {
    let session: TVSession
    @State private var mode = 0
    @State private var activity: [TVActivityItem] = []
    @State private var documents: [TVDocument] = []
    @State private var cursor: String?
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Picker("", selection: $mode) {
                Text("Activity").tag(0)
                Text("Documents").tag(1)
            }
            .pickerStyle(.segmented)
            .onChange(of: mode) { _, _ in Task { await reset() } }

            List {
                if mode == 0 {
                    ForEach(activity) { item in
                        HStack {
                            Text(item.title).lineLimit(1)
                            Spacer()
                            Text(TVTime.short(item.at)).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    ForEach(documents) { doc in
                        NavigationLink(value: doc) {
                            HStack {
                                Text(doc.title).lineLimit(1)
                                Spacer()
                                Text(TVTime.short(doc.at)).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if cursor != nil {
                    Button("Load more") { Task { await loadMore() } }.disabled(loading)
                }
            }
        }
        .padding(60)
        .navigationDestination(for: TVDocument.self) { doc in
            TVPDFView(session: session, document: doc)
        }
        .task { await reset() }
    }

    private func reset() async {
        activity = []; documents = []; cursor = nil
        await loadMore()
    }

    private func loadMore() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            if mode == 0 {
                let page = try await session.activity(cursor: cursor)
                activity += page.items
                cursor = page.nextCursor
            } else {
                let page = try await session.documents(type: nil, cursor: cursor)
                documents += page.items
                cursor = page.nextCursor
            }
        } catch {
            cursor = nil
        }
    }
}

struct TVPDFView: View {
    let session: TVSession
    let document: TVDocument
    @State private var pages: [UIImage] = []
    @State private var failed = false

    var body: some View {
        ScrollView {
            VStack(spacing: 32) {
                ForEach(Array(pages.enumerated()), id: \.offset) { _, page in
                    Image(uiImage: page).resizable().scaledToFit().frame(maxWidth: 1000)
                }
                if failed { Text("This document could not be opened.").font(.title3) }
            }
            .padding(40)
        }
        .task { await load() }
    }

    private func load() async {
        do {
            let data = try await session.pdf(document.id)
            pages = TVPDFRenderer.images(from: data)
        } catch {
            failed = true
        }
    }
}

enum TVPDFRenderer {
    static func images(from data: Data, width: CGFloat = 1000) -> [UIImage] {
        guard let provider = CGDataProvider(data: data as CFData),
              let pdf = CGPDFDocument(provider) else { return [] }
        return (1...max(pdf.numberOfPages, 1)).compactMap { number -> UIImage? in
            guard let page = pdf.page(at: number) else { return nil }
            let box = page.getBoxRect(.mediaBox)
            let scale = width / box.width
            let size = CGSize(width: width, height: box.height * scale)
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            return UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                let cg = context.cgContext
                cg.translateBy(x: 0, y: size.height)
                cg.scaleBy(x: scale, y: -scale)
                cg.drawPDFPage(page)
            }
        }
    }
}
