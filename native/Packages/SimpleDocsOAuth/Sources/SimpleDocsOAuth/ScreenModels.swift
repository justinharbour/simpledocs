import Foundation
import Observation
import SimpleDocsConnected

// View models for the screens. They hold no UI types, so `swift test` covers them with a stub URLProtocol.

/// Downloads one authenticated file (PDF or audio) to a temp file the system players can open.
@MainActor @Observable public final class RemoteFile {
    public enum Load: Equatable { case idle, loading, ready(URL), failed(String) }
    public private(set) var load = Load.idle
    public let path: String
    public let name: String
    private let session: ConnectedModel

    public init(session: ConnectedModel, path: String, name: String) {
        self.session = session; self.path = path; self.name = name
    }

    public var url: URL? { if case .ready(let url) = load { url } else { nil } }

    public func fetch() async {
        if case .ready = load { return }
        load = .loading
        do {
            let (path, name) = (self.path, self.name)
            load = .ready(try await session.call { try await $0.download(path: path, filename: name) })
        } catch is CancellationError {
            load = .idle
        } catch { load = .failed(describe(error)) }
    }
}

@MainActor @Observable public final class RecordsModel {
    public private(set) var records: [RecordItem] = []
    public private(set) var phase = Phase.idle
    private let session: ConnectedModel

    public init(session: ConnectedModel) { self.session = session }

    public var hasActive: Bool { records.contains(where: \.isActive) }

    /// `quiet` refreshes in place (polling) without swapping the list for a spinner.
    public func load(quiet: Bool = false) async {
        if !quiet && records.isEmpty { phase = .loading }
        do {
            let items = try await session.call { try await $0.records() }
            records = items.enumerated().sorted { lhs, rhs in
                let (a, b) = (lhs.element.date ?? .distantPast, rhs.element.date ?? .distantPast)
                return a == b ? lhs.offset < rhs.offset : a > b
            }.map(\.element)
            phase = .loaded
        } catch is CancellationError {
        } catch { phase = .failed(describe(error)) }
    }

    /// Keeps the list fresh while any delivery is still moving. Cancelled with the view's task.
    public func watch(every interval: Duration = .seconds(4)) async {
        while !Task.isCancelled, hasActive {
            try? await Task.sleep(for: interval)
            if Task.isCancelled { return }
            await load(quiet: true)
        }
    }
}

@MainActor @Observable public final class TransmissionModel {
    public private(set) var detail: TransmissionDetail?
    public private(set) var phase = Phase.idle
    public private(set) var approvalError: String?
    public private(set) var approvingID: String?
    public let id: String
    private let session: ConnectedModel

    public init(session: ConnectedModel, id: String) { self.session = session; self.id = id }

    public func load(quiet: Bool = false) async {
        if !quiet && detail == nil { phase = .loading }
        do {
            let id = self.id
            detail = try await session.call { try await $0.transmission(id: id) }
            phase = .loaded
        } catch is CancellationError {
        } catch { phase = .failed(describe(error)) }
    }

    public func watch(every interval: Duration = .seconds(4)) async {
        await load()
        while !Task.isCancelled, detail?.isActive ?? false {
            try? await Task.sleep(for: interval)
            if Task.isCancelled { return }
            await load(quiet: true)
        }
    }

    /// Local review of the exact letter for one mode. Nothing is mailed until `approve` runs.
    public private(set) var mailReview: (deliveryID: String, review: MailReview)?

    public func reviewMail(_ delivery: DeliveryDetail, mode: MailMode) async {
        approvalError = nil
        approvingID = delivery.id
        defer { approvingID = nil }
        do {
            let (id, deliveryID) = (self.id, delivery.id)
            let review = try await session.call { try await $0.mailReview(transmissionID: id, deliveryID: deliveryID, mode: mode) }
            mailReview = (delivery.id, review)
            if !review.available { approvalError = "Paper mail in \(mode.rawValue) mode isn't set up on this instance, so the letter can't be mailed." }
        } catch is CancellationError {
        } catch { approvalError = describe(error) }
    }

    public func cancelReview() { mailReview = nil; approvalError = nil }

    /// Approves exactly what was reviewed. The Worker rejects it if the letter changed since.
    public func approveMail(_ delivery: DeliveryDetail) async {
        guard let shown = mailReview, shown.deliveryID == delivery.id, shown.review.available,
              let mode = MailMode(rawValue: shown.review.mode) else { return }
        approvalError = nil
        approvingID = delivery.id
        defer { approvingID = nil }
        do {
            let (id, deliveryID, hash) = (self.id, delivery.id, shown.review.reviewHash)
            try await session.call { try await $0.approveMail(transmissionID: id, deliveryID: deliveryID, mode: mode, reviewHash: hash) }
            mailReview = nil
            await load(quiet: true)
        } catch is CancellationError {
        } catch { approvalError = describe(error) }
    }

    // Cached so a re-rendered screen keeps the file it already downloaded.
    @ObservationIgnored private var files: [String: RemoteFile] = [:]

    private func cached(_ path: String, name: String) -> RemoteFile {
        if let file = files[path] { return file }
        let file = RemoteFile(session: session, path: path, name: name)
        files[path] = file
        return file
    }

    public func document() -> RemoteFile? {
        detail.map { cached($0.documentUrl, name: "\($0.title).pdf") }
    }

    public func cover(_ delivery: DeliveryDetail) -> RemoteFile? {
        delivery.coverUrl.map { cached($0, name: "Cover page.pdf") }
    }
}

@MainActor @Observable public final class CallsModel {
    public private(set) var calls: [CallItem] = []
    public private(set) var voicemails: [Recording] = []
    public private(set) var phase = Phase.idle
    public private(set) var actionError: String?
    private let session: ConnectedModel

    public init(session: ConnectedModel) { self.session = session }

    public var newCount: Int { voicemails.filter(\.isNew).count }

    public func load() async {
        if calls.isEmpty && voicemails.isEmpty { phase = .loading }
        do {
            async let callList = session.call { try await $0.calls() }
            async let recordingList = session.call { try await $0.recordings() }
            let (fetchedCalls, fetchedRecordings) = try await (callList, recordingList)
            calls = fetchedCalls
            voicemails = fetchedRecordings.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
            phase = .loaded
        } catch is CancellationError {
        } catch { phase = .failed(describe(error)) }
    }

    @ObservationIgnored private var files: [String: RemoteFile] = [:]

    public func file(for recording: Recording) -> RemoteFile {
        if let file = files[recording.id] { return file }
        let file = RemoteFile(session: session, path: recording.path, name: recording.kind == "voicemail" ? "Voicemail" : "Call recording")
        files[recording.id] = file
        return file
    }

    /// Marks it heard on screen right away and puts it back if the Worker refuses.
    public func markHeard(_ recording: Recording) async {
        guard recording.isNew, let index = voicemails.firstIndex(where: { $0.id == recording.id }) else { return }
        voicemails[index].heardAt = ISO8601DateFormatter().string(from: Date())
        do {
            let id = recording.id
            try await session.call { try await $0.markHeard(recordingID: id) }
            actionError = nil
        } catch is CancellationError {
        } catch {
            if let again = voicemails.firstIndex(where: { $0.id == recording.id }) { voicemails[again].heardAt = nil }
            actionError = describe(error)
        }
    }

    public func dismissActionError() { actionError = nil }
}

@MainActor @Observable public final class SettingsModel {
    public enum VoicemailState: Equatable { case loading, editable, missingOnInstance, failed(String) }

    public var senderName = ""
    public var mailFrom = MailContact()
    public var faxFrom: String?
    public var greeting = ""
    public var voice = VoicePreset.kokoro.id
    public private(set) var serviceLevel = VoicePreset.kokoro.serviceLevel
    public private(set) var phase = Phase.idle
    public private(set) var voicemail = VoicemailState.loading
    public private(set) var saveMessage: String?
    public private(set) var saveError: String?
    public private(set) var saving = false
    private var savedSender = ""
    private var savedFrom = MailContact()
    private var savedVoicemail: VoicemailSettings?
    private let session: ConnectedModel

    public init(session: ConnectedModel) { self.session = session }

    public var customVoice: Bool { VoicePreset.preset(for: voice) == nil }
    public var greetingRemaining: Int { VoicePreset.greetingLimit - greeting.count }
    public var senderChanged: Bool { senderName.trimmed != savedSender || (!mailFrom.isBlank && mailFrom != savedFrom) }
    public var voicemailChanged: Bool { savedVoicemail != currentVoicemail }

    private var currentVoicemail: VoicemailSettings {
        let level: String
        if let preset = VoicePreset.preset(for: voice) { level = preset.serviceLevel }
        else { level = voice.localizedCaseInsensitiveContains("neural") ? "premium" : "basic" }
        return VoicemailSettings(greeting: greeting, voice: voice.trimmed, serviceLevel: level)
    }

    public func load() async {
        if phase != .loaded { phase = .loading }
        do {
            let value = try await session.call { try await $0.settings() }
            apply(value)
            phase = .loaded
        } catch is CancellationError {
        } catch { phase = .failed(describe(error)) }
        do {
            let value = try await session.call { try await $0.voicemailSettings() }
            greeting = value.greeting; voice = value.voice; serviceLevel = value.serviceLevel
            savedVoicemail = currentVoicemail
            voicemail = .editable
        } catch is CancellationError {
        } catch { voicemail = isNotFound(error) ? .missingOnInstance : .failed(describe(error)) }
    }

    private func apply(_ value: WorkerSettings) {
        senderName = value.senderName; savedSender = value.senderName
        mailFrom = value.mailFrom ?? MailContact(); savedFrom = mailFrom
        faxFrom = value.faxFrom
    }

    public func saveSender() async {
        saveMessage = nil; saveError = nil
        guard !senderName.trimmed.isEmpty else { saveError = "Enter a sender name."; return }
        if !mailFrom.isBlank, let problem = mailFrom.problem("Return address") { saveError = problem; return }
        saving = true
        defer { saving = false }
        do {
            let update = SettingsUpdate(senderName: senderName.trimmed, mailFrom: mailFrom.isBlank ? nil : mailFrom)
            apply(try await session.call { try await $0.updateSettings(update) })
            saveMessage = "Saved."
        } catch is CancellationError {
        } catch { saveError = describe(error) }
    }

    public func saveVoicemail() async {
        saveMessage = nil; saveError = nil
        guard !voice.trimmed.isEmpty else { saveError = "Choose a voice or enter a voice ID."; return }
        guard greeting.count <= VoicePreset.greetingLimit else { saveError = "The greeting can be at most \(VoicePreset.greetingLimit) characters."; return }
        saving = true
        defer { saving = false }
        do {
            let value = currentVoicemail
            let saved = try await session.call { try await $0.saveVoicemailSettings(value) }
            greeting = saved.greeting; voice = saved.voice; serviceLevel = saved.serviceLevel
            savedVoicemail = currentVoicemail
            saveMessage = "Saved. New callers will hear this greeting."
        } catch is CancellationError {
        } catch { saveError = describe(error) }
    }
}

/// A PDF chosen for sending. The page count comes from PDFKit in the app, which owns that framework.
public struct PickedDocument: Equatable, Sendable {
    public static let limit = 5 * 1024 * 1024
    public let data: Data
    public let name: String
    public let pageCount: Int

    public init(data: Data, name: String, pageCount: Int) { self.data = data; self.name = name; self.pageCount = pageCount }

    public var byteCount: Int { data.count }
    public var title: String { name.lowercased().hasSuffix(".pdf") ? String(name.dropLast(4)) : name }

    /// The Worker's own limits, checked before a slow upload.
    public static func problem(for data: Data) -> String? {
        if data.isEmpty { return "That file is empty." }
        if data.count > limit { return "Choose a PDF under 5 MB." }
        if data.prefix(5) != Data("%PDF-".utf8) { return "That file is not a PDF." }
        return nil
    }
}

@MainActor @Observable public final class SendModel {
    public enum Step: Equatable { case compose, review, sending, sent(SentSummary) }

    public struct SentSummary: Equatable, Sendable {
        public let transmissionID: String
        public let faxCount: Int
        public let letterApproved: Bool
        /// Set when the letter exists but was not approved, so nothing was mailed.
        public let letterProblem: String?
    }

    public var draft = SendDraft()
    public private(set) var document: PickedDocument?
    public private(set) var step = Step.compose
    public private(set) var error: String?
    public private(set) var documentError: String?
    private let session: ConnectedModel
    private var prefilled = false

    public init(session: ConnectedModel) { self.session = session }

    public var problems: [String] { draft.problems(hasDocument: document != nil) }
    public var canReview: Bool { problems.isEmpty }
    public var needsLiveConfirmation: Bool { draft.channels.hasMail && draft.mode == .live }
    public var sendButtonTitle: String {
        guard draft.channels.hasMail else { return "Send fax" }
        return draft.mode == .live ? "Send a real letter" : (draft.channels.hasFax ? "Send fax and test letter" : "Send test letter")
    }

    public func choose(data: Data, name: String, pageCount: Int?) {
        if let problem = PickedDocument.problem(for: data) { documentError = problem; return }
        guard let pageCount, pageCount > 0 else { documentError = "That PDF could not be read. Try exporting it again."; return }
        documentError = nil
        document = PickedDocument(data: data, name: name, pageCount: pageCount)
    }

    public func rejectDocument(_ message: String) { documentError = message }
    public func clearDocument() { document = nil }

    /// Fills sender details once from the instance settings so the cover page and return address start right.
    public func prefill() async {
        guard !prefilled else { return }
        prefilled = true
        guard let settings = try? await session.call({ try await $0.settings() }) else { prefilled = false; return }
        if draft.cover.from.trimmed.isEmpty { draft.cover.from = settings.senderName }
        if draft.mailFrom.isBlank, let from = settings.mailFrom { draft.mailFrom = from }
    }

    public func review() {
        error = nil
        guard canReview else { return }
        step = .review
    }

    public func backToCompose() { error = nil; step = .compose }

    public func reset() {
        draft = SendDraft(); document = nil; error = nil; documentError = nil; step = .compose; prefilled = false
    }

    public func send() async {
        guard let document, canReview, step == .review else { return }
        step = .sending
        error = nil
        do {
            let spec = try draft.spec(fallbackTitle: document.title)
            let (data, name) = (document.data, document.name)
            let created = try await session.call { try await $0.createTransmission(pdf: data, filename: name, spec: spec) }
            var approved = false
            var problem: String?
            if draft.channels.hasMail, let letter = created.deliveries.first(where: { $0.channel == "mail" }) {
                let (id, mode) = (created.id, draft.mode)
                do {
                    try await session.call { api in
                        let review = try await api.mailReview(transmissionID: id, deliveryID: letter.id, mode: mode)
                        guard review.available else { throw APIError.server(status: 503, message: "Paper mail in \(mode.rawValue) mode isn't set up on this instance, so the letter was not mailed.") }
                        try await api.approveMail(transmissionID: id, deliveryID: letter.id, mode: mode, reviewHash: review.reviewHash)
                    }
                    approved = true
                } catch { problem = describe(error) }
            }
            step = .sent(SentSummary(transmissionID: created.id, faxCount: created.deliveries.filter { $0.channel == "fax" }.count,
                                     letterApproved: approved, letterProblem: problem))
        } catch is CancellationError {
            step = .review
        } catch {
            self.error = describe(error)
            step = .review
        }
    }
}
