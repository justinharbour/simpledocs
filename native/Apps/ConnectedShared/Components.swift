import AuthenticationServices
import AVFoundation
import PDFKit
import SimpleDocsConnected
import SimpleDocsOAuth
import SwiftUI

#if os(macOS)
import AppKit
typealias PlatformImage = NSImage
#else
import UIKit
typealias PlatformImage = UIImage
#endif

extension Image {
    init(platform image: PlatformImage) {
        #if os(macOS)
        self.init(nsImage: image)
        #else
        self.init(uiImage: image)
        #endif
    }
}

// MARK: Sign-in anchor

@MainActor final class AppAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
        #else
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        #endif
    }
}

// MARK: Navigation state shared with the macOS menu

enum Area: String, CaseIterable, Identifiable, Hashable {
    case send, records, calls, settings
    var id: String { rawValue }
    var title: String {
        switch self { case .send: "Send"; case .records: "Records"; case .calls: "Calls"; case .settings: "Settings" }
    }
    var symbol: String {
        switch self { case .send: "paperplane"; case .records: "tray.full"; case .calls: "phone"; case .settings: "gearshape" }
    }
}

@MainActor @Observable final class AppActions {
    var area = Area.send
    private(set) var refreshTick = 0
    private(set) var newSendTick = 0

    func newSend() { area = .send; newSendTick += 1 }
    func refresh() { refreshTick += 1 }
}

// MARK: Status

struct StatusBadge: View {
    let channel: String
    let status: String

    private var tint: Color {
        switch status {
        case "delivered", "received", "heard": .green
        case "failed": .red
        case "awaiting_approval", "unknown", "unheard": .orange
        case "completed": .blue
        default: .secondary
        }
    }

    private var symbol: String {
        switch status {
        case "delivered", "received", "heard": "checkmark.circle.fill"
        case "failed": "exclamationmark.triangle.fill"
        case "awaiting_approval", "unknown": "questionmark.circle.fill"
        case "unheard": "circle.fill"
        case "completed": "checkmark.circle"
        default: "clock"
        }
    }

    var body: some View {
        Label("\(DeliveryStatus.channelLabel(channel)): \(DeliveryStatus.label(status))", systemImage: symbol)
            .font(.caption)
            .foregroundStyle(tint)
            .labelStyle(.titleAndIcon)
            .accessibilityLabel("\(DeliveryStatus.channelLabel(channel)), \(DeliveryStatus.label(status))")
    }
}

// MARK: Feedback

struct ErrorBanner: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityHidden(true)
            Text(message).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
            if let retry { Button("Retry", action: retry) }
        }
        .padding(12)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }
}

// MARK: PDF

func firstPage(of document: PDFDocument?, height: CGFloat = 320) -> PlatformImage? {
    guard let page = document?.page(at: 0) else { return nil }
    return page.thumbnail(of: CGSize(width: height * 0.78, height: height), for: .mediaBox)
}

struct PDFThumbnail: View {
    let image: PlatformImage?
    var height: CGFloat = 160

    var body: some View {
        Group {
            if let image {
                Image(platform: image).resizable().scaledToFit()
            } else {
                Image(systemName: "doc.richtext").font(.largeTitle).foregroundStyle(.secondary)
            }
        }
        .frame(height: height)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
        .accessibilityLabel("First page preview")
    }
}

#if os(macOS)
struct PDFKitView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = PDFDocument(url: url)
        return view
    }
    func updateNSView(_ view: PDFView, context: Context) {
        if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
    }
}
#else
struct PDFKitView: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = PDFDocument(url: url)
        return view
    }
    func updateUIView(_ view: PDFView, context: Context) {
        if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
    }
}
#endif

/// Full-size PDF viewer for a file that is downloaded with the session's token.
struct RemotePDFScreen: View {
    let file: RemoteFile

    var body: some View {
        Group {
            switch file.load {
            case .idle, .loading: ProgressView("Loading document…")
            case .failed(let message): ErrorBanner(message: message) { Task { await file.fetch() } }.padding()
            case .ready(let url): PDFKitView(url: url)
            }
        }
        .navigationTitle(file.name)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            if let url = file.url { ToolbarItem { ShareLink(item: url) } }
        }
        .task { await file.fetch() }
    }
}

/// A first-page thumbnail that opens the full document.
struct DocumentRow: View {
    let file: RemoteFile
    @State private var image: PlatformImage?

    var body: some View {
        NavigationLink {
            RemotePDFScreen(file: file)
        } label: {
            HStack(spacing: 14) {
                Group {
                    if case .loading = file.load { ProgressView() } else { PDFThumbnail(image: image, height: 120) }
                }
                .frame(width: 96)
                VStack(alignment: .leading, spacing: 2) {
                    Text(file.name).font(.body)
                    Text(file.load.errorText ?? "Open the full document").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .task { await file.fetch() }
        .task(id: file.url) {
            if let url = file.url { image = firstPage(of: PDFDocument(url: url), height: 240) }
        }
    }
}

extension RemoteFile.Load {
    var errorText: String? { if case .failed(let text) = self { text } else { nil } }
}

// MARK: Audio

@MainActor @Observable final class AudioController {
    private(set) var isPlaying = false
    private(set) var position: TimeInterval = 0
    private(set) var duration: TimeInterval = 0
    private(set) var error: String?
    private var player: AVAudioPlayer?
    private var ticker: Task<Void, Never>?

    func load(_ url: URL) {
        do {
            #if os(iOS)
            try AVAudioSession.sharedInstance().setCategory(.playback)
            #endif
            let player = try AVAudioPlayer(contentsOf: url)
            player.prepareToPlay()
            self.player = player
            duration = player.duration
            error = nil
        } catch { self.error = "This recording can't be played here. Use Share to open it in another app." }
    }

    /// Returns true when playback started.
    func toggle() -> Bool {
        guard let player else { return false }
        if player.isPlaying {
            player.pause()
            isPlaying = false
            ticker?.cancel()
            return false
        }
        guard player.play() else { error = "Playback could not start."; return false }
        isPlaying = true
        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, let player = self.player else { return }
                self.position = player.currentTime
                if !player.isPlaying { self.isPlaying = false; return }
            }
        }
        return true
    }

    func seek(to time: TimeInterval) {
        player?.currentTime = time
        position = time
    }

    func stop() {
        ticker?.cancel()
        player?.stop()
        isPlaying = false
    }
}

func clock(_ seconds: TimeInterval) -> String {
    let total = Int(seconds.rounded())
    return String(format: "%d:%02d", total / 60, total % 60)
}

struct AudioPlayerView: View {
    let file: RemoteFile
    var onFirstPlay: () -> Void = {}
    @State private var audio = AudioController()
    @State private var started = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch file.load {
            case .idle, .loading:
                ProgressView("Loading audio…")
            case .failed(let message):
                ErrorBanner(message: message) { Task { await file.fetch() } }
            case .ready:
                if let error = audio.error {
                    Text(error).font(.callout).foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 12) {
                        Button {
                            if audio.toggle(), !started { started = true; onFirstPlay() }
                        } label: {
                            Image(systemName: audio.isPlaying ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 36))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(audio.isPlaying ? "Pause voicemail" : "Play voicemail")
                        Slider(value: Binding(get: { audio.position }, set: { audio.seek(to: $0) }), in: 0...max(audio.duration, 1))
                            .accessibilityLabel("Playback position")
                        Text("\(clock(audio.position)) / \(clock(audio.duration))")
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .task { await file.fetch() }
        .task(id: file.url) { if let url = file.url { audio.load(url) } }
        .onDisappear { audio.stop() }
    }
}

// MARK: Formatting

extension Date {
    var short: String { formatted(.dateTime.month(.abbreviated).day().hour().minute()) }
}
