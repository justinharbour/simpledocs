import SimpleDocsConnected
import SimpleDocsOAuth
import SwiftUI

struct CallsView: View {
    let model: CallsModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        content
            .navigationTitle("Calls")
            .task { await model.load() }
            .toolbar {
                ToolbarItem { Button { Task { await model.load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") } }
            }
    }

    @ViewBuilder private var content: some View {
        if model.calls.isEmpty && model.voicemails.isEmpty {
            switch model.phase {
            case .failed(let message): ErrorBanner(message: message) { Task { await model.load() } }.padding()
            case .loaded:
                ContentUnavailableView("No calls yet", systemImage: "phone",
                                       description: Text("Calls and voicemails to your number appear here."))
            default: ProgressView("Loading calls…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            List {
                if let message = model.phase.error { ErrorBanner(message: message) { Task { await model.load() } }.listRowSeparator(.hidden) }
                if let message = model.actionError { ErrorBanner(message: message) { model.dismissActionError() }.listRowSeparator(.hidden) }
                if !model.voicemails.isEmpty {
                    Section("Voicemail") {
                        ForEach(model.voicemails) { recording in
                            NavigationLink { VoicemailView(model: model, recording: recording) } label: { VoicemailRow(recording: recording) }
                        }
                    }
                }
                if !model.calls.isEmpty {
                    Section("Calls") {
                        ForEach(model.calls) { call in CallRow(call: call) { number in dial(number) } }
                    }
                }
            }
            .refreshable { await model.load() }
        }
    }

    private func dial(_ number: String) {
        if let url = URL(string: "tel:\(number)") { openURL(url) }
    }
}

private func who(_ number: String?) -> String { number.map(PhoneNumber.display) ?? "Unknown number" }

struct VoicemailRow: View {
    let recording: Recording

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: recording.isNew ? "circle.fill" : "circle").font(.caption2)
                .foregroundStyle(recording.isNew ? Color.accentColor : Color.clear).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(who(recording.fromNumber)).font(.headline)
                if let transcript = recording.transcript, !transcript.isEmpty {
                    Text(transcript).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 8) {
                    if let date = recording.date { Text(date.short) }
                    if let secs = recording.durationSecs { Text(clock(TimeInterval(secs))) }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(recording.isNew ? "New voicemail" : "Voicemail") from \(who(recording.fromNumber))")
    }
}

struct CallRow: View {
    let call: CallItem
    let dial: (String) -> Void

    var body: some View {
        HStack {
            Image(systemName: call.direction == "inbound" ? "phone.arrow.down.left" : "phone.arrow.up.right")
                .foregroundStyle(.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(who(call.otherParty)).font(.headline)
                HStack(spacing: 8) {
                    Text(DeliveryStatus.label(call.outcome))
                    if let date = call.date { Text(date.short) }
                    if let secs = call.durationSecs, secs > 0 { Text(clock(TimeInterval(secs))) }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let number = call.otherParty {
                Button { dial(number) } label: { Image(systemName: "phone.fill") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Call back \(who(number))")
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct VoicemailView: View {
    let model: CallsModel
    let recording: Recording
    @Environment(\.openURL) private var openURL

    private var current: Recording { model.voicemails.first { $0.id == recording.id } ?? recording }

    var body: some View {
        let file = model.file(for: current)
        List {
            Section {
                LabeledContent("From", value: who(current.fromNumber))
                if let date = current.date { LabeledContent("Received", value: date.formatted(date: .abbreviated, time: .shortened)) }
                LabeledContent("Status", value: current.isNew ? "New" : "Heard")
            }
            Section("Listen") {
                AudioPlayerView(file: file) { Task { await model.markHeard(current) } }
            }
            Section("Transcript") {
                if let text = current.transcript, !text.isEmpty { Text(text).textSelection(.enabled) }
                else { Text("No transcript for this voicemail.").foregroundStyle(.secondary) }
            }
            Section {
                if let number = current.fromNumber {
                    Button { if let url = URL(string: "tel:\(number)") { openURL(url) } } label: { Label("Call back", systemImage: "phone.fill") }
                }
                if current.isNew {
                    Button { Task { await model.markHeard(current) } } label: { Label("Mark as heard", systemImage: "checkmark.circle") }
                }
                if let url = file.url { ShareLink(item: url) { Label("Share or save recording", systemImage: "square.and.arrow.up") } }
            } footer: {
                Text("Call back opens your phone's dialer. This app doesn't place calls itself.")
            }
        }
        .navigationTitle("Voicemail")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task { await file.fetch() }
    }
}
