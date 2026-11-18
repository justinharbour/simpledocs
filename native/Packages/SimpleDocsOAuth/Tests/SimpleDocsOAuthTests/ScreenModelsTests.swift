import AuthenticationServices
import Foundation
import Testing
import SimpleDocsConnected
@testable import SimpleDocsOAuth

@MainActor private final class Anchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { ASPresentationAnchor() }
}

private func ok(_ text: String, status: Int = 200) -> Stub { Stub(status: status, body: Data(text.utf8)) }

/// A model that is already signed in, with its API pointed at the stub protocol.
@MainActor private func signedIn() throws -> ConnectedModel {
    let tokens = OAuthTokens(accessToken: "tok", refreshToken: "ref", expiresIn: 900, resource: "https://one.example.com/")
    let stored = StoredSession(instance: "https://one.example.com", issuer: "https://team.cloudflareaccess.com", clientID: "c",
                               tokenEndpoint: URL(string: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token")!,
                               tokens: try ExpiringTokens(tokens: tokens, receivedAt: Date()))
    let vault = MemoryVault()
    try vault.save(stored)
    let model = ConnectedModel(vault: vault, defaults: UserDefaults(suiteName: "simpledocs.tests." + UUID().uuidString)!,
                               anchor: Anchor(), apiProtocolClasses: [StubProtocol.self])
    model.instance = "https://one.example.com"
    model.restore()
    return model
}

private let fax = #"{"type":"transmission","id":"t1","title":"Lease","createdAt":"2026-11-16T10:00:00Z","channels":[{"id":"d1","channel":"fax","status":"accepted"}]}"#
private let older = #"{"type":"inbound_fax","id":"f1","title":"Inbound fax","createdAt":"2026-11-10T10:00:00Z","channels":[{"channel":"fax","status":"received"}]}"#
private let newer = #"{"type":"recording","id":"r1","title":"Voicemail","createdAt":"2026-11-17T10:00:00Z","channels":[{"channel":"voice","status":"unheard"}]}"#

extension StubbedSuites { @MainActor @Suite struct ScreenModelsTests {
    @Test func recordsAreNewestFirstAndActiveIsDetected() async throws {
        StubProtocol.reset(["GET /api/records": [ok(#"{"records":[\#(older),\#(fax),\#(newer)]}"#)]])
        let model = RecordsModel(session: try signedIn())
        await model.load()
        #expect(model.records.map(\.id) == ["r1", "t1", "f1"])
        #expect(model.phase == .loaded && model.hasActive)
    }

    @Test func emptyAccountIsLoadedNotAnError() async throws {
        StubProtocol.reset(["GET /api/records": [ok(#"{"records":[]}"#)]])
        let model = RecordsModel(session: try signedIn())
        await model.load()
        #expect(model.phase == .loaded && model.records.isEmpty)
    }

    @Test func failedRefreshKeepsWhatWasShownAndReportsTheError() async throws {
        StubProtocol.reset(["GET /api/records": [ok(#"{"records":[\#(fax)]}"#), Stub(fail: true)]])
        let model = RecordsModel(session: try signedIn())
        await model.load()
        await model.load(quiet: true)
        #expect(model.records.count == 1)
        #expect(model.phase == .failed(APIError.unreachable.message))
    }

    @Test func pollingStopsOnceEveryChannelIsTerminal() async throws {
        let done = fax.replacingOccurrences(of: "accepted", with: "delivered")
        StubProtocol.reset(["GET /api/records": [ok(#"{"records":[\#(fax)]}"#), ok(#"{"records":[\#(fax)]}"#), ok(#"{"records":[\#(done)]}"#)]])
        let model = RecordsModel(session: try signedIn())
        await model.load()
        await model.watch(every: .milliseconds(1))
        #expect(model.records.first?.channels.first?.status == "delivered")
        #expect(!model.hasActive)
        #expect(StubProtocol.requests.count == 3)
    }

    @Test func transmissionPollingStopsWhenSettledAndIgnoresLettersAwaitingApproval() async throws {
        func detail(_ fax: String, _ mail: String) -> String {
            #"{"id":"t1","title":"Lease","pageCount":2,"createdAt":"2026-11-16T10:00:00Z","updatedAt":"2026-11-16T10:00:00Z","documentUrl":"/api/transmissions/t1/document","settled":false,"deliveries":[{"id":"d1","channel":"fax","recipient":"+12134147728","status":"\#(fax)","providerStatus":null,"error":null,"needsApproval":false,"coverUrl":"/api/transmissions/t1/cover/d1","timeline":[{"at":"2026-11-16T10:00:00Z","status":"queued","detail":null}]},{"id":"d2","channel":"mail","recipient":"Ada, Austin TX","status":"\#(mail)","providerStatus":null,"error":null,"needsApproval":\#(mail == "awaiting_approval"),"coverUrl":null,"timeline":[]}]}"#
        }
        StubProtocol.reset(["GET /api/transmissions/t1": [ok(detail("queued", "awaiting_approval")), ok(detail("delivered", "awaiting_approval"))]])
        let model = TransmissionModel(session: try signedIn(), id: "t1")
        await model.watch(every: .milliseconds(1))
        #expect(model.detail?.deliveries.first?.status == "delivered")
        #expect(model.detail?.isActive == false)
        #expect(StubProtocol.requests.count == 2)
        #expect(model.document()?.path == "/api/transmissions/t1/document")
        let (first, last) = (try #require(model.detail?.deliveries.first), try #require(model.detail?.deliveries.last))
        #expect(model.cover(first)?.path == "/api/transmissions/t1/cover/d1")
        #expect(model.cover(last) == nil)
    }

    @Test func callsLoadTogetherAndNewCountFollowsHeardState() async throws {
        StubProtocol.reset([
            "GET /api/voice/calls": [ok(#"{"calls":[{"id":"c1","direction":"inbound","from":"+12134147728","to":"+15125550100","startedAt":"2026-11-16T10:00:00Z","answeredAt":null,"endedAt":null,"durationSecs":null,"hangupCause":null,"outcome":"voicemail"}]}"#)],
            "GET /api/voice/recordings": [ok(#"{"recordings":[{"recording_id":"r1","archived_at":"2026-11-16 10:00:00","kind":"voicemail","direction":"inbound","from_number":"+12134147728","to_number":null,"duration_secs":9,"heard_at":null,"transcript":"Call me"},{"recording_id":"r0","archived_at":"2026-11-15 10:00:00","kind":"voicemail","direction":"inbound","from_number":null,"to_number":null,"duration_secs":3,"heard_at":"2026-11-15T11:00:00Z","transcript":null}]}"#)],
            "POST /api/voice/recordings/r1/heard": [ok(#"{"id":"r1","heard":true}"#)],
        ])
        let model = CallsModel(session: try signedIn())
        await model.load()
        #expect(model.calls.count == 1 && model.voicemails.map(\.id) == ["r1", "r0"] && model.newCount == 1)
        await model.markHeard(model.voicemails[0])
        #expect(model.newCount == 0 && model.actionError == nil)
        #expect(StubProtocol.requests.last?.method == "POST")
    }

    @Test func heardIsRolledBackWhenTheWorkerRefuses() async throws {
        StubProtocol.reset([
            "GET /api/voice/calls": [ok(#"{"calls":[]}"#)],
            "GET /api/voice/recordings": [ok(#"{"recordings":[{"recording_id":"r1","archived_at":"2026-11-16 10:00:00","kind":"voicemail","direction":"inbound","from_number":null,"to_number":null,"duration_secs":9,"heard_at":null,"transcript":null}]}"#)],
            "POST /api/voice/recordings/r1/heard": [ok(#"{"error":"Not found"}"#, status: 404)],
        ])
        let model = CallsModel(session: try signedIn())
        await model.load()
        await model.markHeard(model.voicemails[0])
        #expect(model.newCount == 1 && model.actionError == "Not found")
    }

    @Test func settingsLoadAndSaveSenderAndReturnAddress() async throws {
        StubProtocol.reset([
            "GET /api/settings": [ok(#"{"senderName":"Ada","mailFrom":null,"faxFrom":"+15125550100"}"#)],
            "GET /api/settings/voicemail": [ok(#"{"greeting":"Leave a message.","voice":"Telnyx.KokoroTTS.af","service_level":"basic"}"#)],
            "PUT /api/settings": [ok(#"{"senderName":"Ada L","mailFrom":{"firstName":"Ada","addressLine1":"1 Main St","city":"Austin","provinceOrState":"TX","postalOrZip":"78701","countryCode":"US"},"faxFrom":"+15125550100"}"#)],
        ])
        let model = SettingsModel(session: try signedIn())
        await model.load()
        #expect(model.senderName == "Ada" && model.faxFrom == "+15125550100" && model.voicemail == .editable && !model.senderChanged)
        model.senderName = "Ada L"
        #expect(model.senderChanged)
        model.mailFrom.firstName = "Ada"; model.mailFrom.addressLine1 = "1 Main St"; model.mailFrom.city = "Austin"
        model.mailFrom.provinceOrState = "tx"; model.mailFrom.postalOrZip = "78701"
        await model.saveSender()
        #expect(model.saveMessage == "Saved." && model.saveError == nil && !model.senderChanged)
        let sent = try #require(StubProtocol.requests.last?.body)
        let body = try #require(JSONSerialization.jsonObject(with: sent) as? [String: Any])
        #expect(body["senderName"] as? String == "Ada L")
        #expect((body["mailFrom"] as? [String: Any])?["provinceOrState"] as? String == "TX")
    }

    @Test func incompleteReturnAddressIsRefusedBeforeSaving() async throws {
        StubProtocol.reset(["GET /api/settings": [ok(#"{"senderName":"Ada","mailFrom":null,"faxFrom":null}"#)], "GET /api/settings/voicemail": [ok("{}", status: 404)]])
        let model = SettingsModel(session: try signedIn())
        await model.load()
        model.mailFrom.firstName = "Ada"
        await model.saveSender()
        #expect(model.saveError?.contains("street") == true)
        #expect(StubProtocol.requests.allSatisfy { $0.method == "GET" })
    }

    @Test func voicemailRouteMissingIsReportedHonestly() async throws {
        StubProtocol.reset(["GET /api/settings": [ok(#"{"senderName":"Ada","mailFrom":null,"faxFrom":null}"#)], "GET /api/settings/voicemail": [ok(#"{"error":"Not found"}"#, status: 404)]])
        let model = SettingsModel(session: try signedIn())
        await model.load()
        #expect(model.phase == .loaded && model.voicemail == .missingOnInstance)
    }

    @Test func voicemailEditorSendsPresetServiceLevelAndCustomIDs() async throws {
        StubProtocol.reset([
            "GET /api/settings": [ok(#"{"senderName":"Ada","mailFrom":null,"faxFrom":null}"#)],
            "GET /api/settings/voicemail": [ok(#"{"greeting":"Hi","voice":"Telnyx.KokoroTTS.af","service_level":"basic"}"#)],
            "PUT /api/settings/voicemail": [ok(#"{"greeting":"Hello","voice":"AWS.Polly.Joanna-Neural","service_level":"premium"}"#), ok(#"{"greeting":"Hello","voice":"Acme.Custom.Neural","service_level":"premium"}"#)],
        ])
        let model = SettingsModel(session: try signedIn())
        await model.load()
        #expect(!model.voicemailChanged && !model.customVoice && model.greetingRemaining == 998)
        model.greeting = "Hello"; model.voice = "AWS.Polly.Joanna-Neural"
        #expect(model.voicemailChanged)
        await model.saveVoicemail()
        var sent = try #require(StubProtocol.requests.last?.body)
        var body = try #require(JSONSerialization.jsonObject(with: sent) as? [String: String])
        #expect(body == ["greeting": "Hello", "voice": "AWS.Polly.Joanna-Neural", "service_level": "premium"])
        #expect(model.saveMessage?.hasPrefix("Saved") == true && !model.voicemailChanged)
        model.voice = "Acme.Custom.Neural"
        #expect(model.customVoice)
        await model.saveVoicemail()
        sent = try #require(StubProtocol.requests.last?.body)
        body = try #require(JSONSerialization.jsonObject(with: sent) as? [String: String])
        #expect(body["service_level"] == "premium" && body["voice"] == "Acme.Custom.Neural")
    }

    @Test func greetingOverTheLimitIsRefused() async throws {
        StubProtocol.reset(["GET /api/settings": [ok(#"{"senderName":"A","mailFrom":null,"faxFrom":null}"#)],
                            "GET /api/settings/voicemail": [ok(#"{"greeting":"","voice":"female","service_level":"basic"}"#)]])
        let model = SettingsModel(session: try signedIn())
        await model.load()
        model.greeting = String(repeating: "a", count: 1001)
        #expect(model.greetingRemaining == -1)
        await model.saveVoicemail()
        #expect(model.saveError?.contains("1000") == true)
    }

    // MARK: Send

    private var pdf: Data { Data("%PDF-1.4 test".utf8) }

    @Test func documentChecksMatchTheWorkerLimits() throws {
        let model = SendModel(session: try signedIn())
        model.choose(data: Data(), name: "a.pdf", pageCount: 1)
        #expect(model.documentError == "That file is empty." && model.document == nil)
        model.choose(data: Data("hello".utf8), name: "a.pdf", pageCount: 1)
        #expect(model.documentError == "That file is not a PDF.")
        model.choose(data: Data("%PDF-".utf8) + Data(count: PickedDocument.limit), name: "a.pdf", pageCount: 1)
        #expect(model.documentError == "Choose a PDF under 5 MB.")
        model.choose(data: pdf, name: "a.pdf", pageCount: nil)
        #expect(model.documentError?.contains("could not be read") == true)
        model.choose(data: pdf, name: "Lease.pdf", pageCount: 4)
        #expect(model.documentError == nil && model.document?.title == "Lease" && model.document?.pageCount == 4)
    }

    @Test func reviewIsBlockedUntilTheFormIsComplete() throws {
        let model = SendModel(session: try signedIn())
        model.review()
        #expect(model.step == .compose && !model.canReview)
        model.choose(data: pdf, name: "a.pdf", pageCount: 1)
        model.draft.faxList = "(213) 414-7728"
        model.review()
        #expect(model.step == .review)
        model.backToCompose()
        #expect(model.step == .compose)
    }

    @Test func faxSendPostsNormalizedRecipientsAndNeverTouchesMailRoutes() async throws {
        StubProtocol.reset(["POST /api/transmissions": [ok(#"{"id":"t1","deliveries":[{"id":"d1","channel":"fax","status":"queued"}]}"#, status: 202)]])
        let model = SendModel(session: try signedIn())
        model.choose(data: pdf, name: "Lease.pdf", pageCount: 2)
        model.draft.faxList = "213.414.7728"
        model.review()
        await model.send()
        #expect(model.step == .sent(.init(transmissionID: "t1", envelopeNumber: nil, faxCount: 1, letterApproved: false, letterProblem: nil)))
        #expect(StubProtocol.requests.map(\.url.path) == ["/api/transmissions"])
        #expect(String(decoding: StubProtocol.requests[0].body, as: UTF8.self).contains("+12134147728"))
    }

    @Test func uploadsMultipleDocumentsInReviewedOrder() async throws {
        StubProtocol.reset(["POST /api/transmissions": [ok(#"{"id":"t1","envelopeNumber":"000001","deliveries":[{"id":"d1","channel":"fax","status":"queued"}]}"#, status: 202)]])
        let model = SendModel(session: try signedIn())
        model.choose(data: pdf, name: "one.pdf", pageCount: 1)
        model.choose(data: pdf, name: "two.pdf", pageCount: 2)
        model.choose(data: pdf, name: "too-long.pdf", pageCount: 98)
        #expect(model.documentError?.contains("100 pages") == true)
        model.draft.faxList = "(512) 555-0100"
        model.draft.cover.includeNumbers = true
        model.draft.numberDocumentPages = true
        model.review()
        #expect(model.step == .order)
        model.moveDocument(from: 1, to: 0)
        model.review()
        model.backFromReview()
        #expect(model.step == .order && model.documents.map(\.name) == ["two.pdf", "one.pdf"])
        model.review()
        await model.send()
        guard case .sent(let summary) = model.step else { Issue.record("Expected send result"); return }
        #expect(summary.envelopeNumber == "000001")
        let text = String(decoding: StubProtocol.requests[0].body, as: UTF8.self)
        let first = try #require(text.range(of: #"name="numberedDocuments"; filename="two.pdf""#))
        let second = try #require(text.range(of: #"name="numberedDocuments"; filename="one.pdf""#))
        #expect(first.lowerBound < second.lowerBound)
        #expect(text.contains(#""includeNumbers":true"#))
    }

    @Test func mailSendReviewsThenApprovesWithTheChosenMode() async throws {
        let hash = String(repeating: "b", count: 64)
        StubProtocol.reset([
            "POST /api/transmissions": [ok(#"{"id":"t1","deliveries":[{"id":"d2","channel":"mail","status":"awaiting_approval"}]}"#, status: 202)],
            "GET /api/transmissions/t1/mail/d2/review": [ok(#"{"mode":"test","reviewHash":"\#(hash)","pageCount":2,"summary":{},"status":"awaiting_approval","available":true,"notice":"n"}"#)],
            "POST /api/transmissions/t1/mail/d2/approve": [ok(#"{"id":"d2","status":"queued"}"#, status: 202)],
        ])
        let model = SendModel(session: try signedIn())
        model.choose(data: pdf, name: "Letter.pdf", pageCount: 2)
        model.draft.channels = .mail
        for path in [\SendDraft.mailTo, \SendDraft.mailFrom] as [WritableKeyPath<SendDraft, MailContact>] {
            model.draft[keyPath: path].firstName = "Ada"; model.draft[keyPath: path].addressLine1 = "1 Main St"
            model.draft[keyPath: path].city = "Austin"; model.draft[keyPath: path].provinceOrState = "TX"; model.draft[keyPath: path].postalOrZip = "78701"
        }
        #expect(!model.needsLiveConfirmation && model.sendButtonTitle == "Send test letter")
        model.review()
        await model.send()
        #expect(model.step == .sent(.init(transmissionID: "t1", envelopeNumber: nil, faxCount: 0, letterApproved: true, letterProblem: nil)))
        #expect(StubProtocol.requests.map(\.url.path) == ["/api/transmissions", "/api/transmissions/t1/mail/d2/review", "/api/transmissions/t1/mail/d2/approve"])
        #expect(StubProtocol.requests[1].url.query == "mode=test")
        let approval = try #require(JSONSerialization.jsonObject(with: StubProtocol.requests[2].body) as? [String: Any])
        #expect(approval["reviewHash"] as? String == hash && approval["mode"] as? String == "test")
    }

    @Test func liveModeNeedsExplicitConfirmationAndSaysSo() throws {
        let model = SendModel(session: try signedIn())
        model.draft.channels = .both
        model.draft.mode = .live
        #expect(model.needsLiveConfirmation && model.sendButtonTitle == "Send a real letter")
        model.draft.channels = .fax
        #expect(!model.needsLiveConfirmation && model.sendButtonTitle == "Send fax")
    }

    @Test func unavailableMailModeLeavesTheLetterUnapprovedAndSaysNothingWasMailed() async throws {
        StubProtocol.reset([
            "POST /api/transmissions": [ok(#"{"id":"t1","deliveries":[{"id":"d2","channel":"mail","status":"awaiting_approval"}]}"#, status: 202)],
            "GET /api/transmissions/t1/mail/d2/review": [ok(#"{"mode":"live","reviewHash":"\#(String(repeating: "c", count: 64))","pageCount":1,"summary":{},"status":"awaiting_approval","available":false,"notice":"n"}"#)],
        ])
        let model = SendModel(session: try signedIn())
        model.choose(data: pdf, name: "Letter.pdf", pageCount: 1)
        model.draft.channels = .mail
        model.draft.mode = .live
        for path in [\SendDraft.mailTo, \SendDraft.mailFrom] as [WritableKeyPath<SendDraft, MailContact>] {
            model.draft[keyPath: path].firstName = "Ada"; model.draft[keyPath: path].addressLine1 = "1 Main St"
            model.draft[keyPath: path].city = "Austin"; model.draft[keyPath: path].provinceOrState = "TX"; model.draft[keyPath: path].postalOrZip = "78701"
        }
        model.review()
        await model.send()
        guard case .sent(let summary) = model.step else { Issue.record("expected sent"); return }
        #expect(!summary.letterApproved && summary.letterProblem?.contains("not mailed") == true)
        #expect(!StubProtocol.requests.contains { $0.url.path.hasSuffix("/approve") })
    }

    @Test func uploadErrorsReturnToReviewWithTheWorkersMessage() async throws {
        StubProtocol.reset(["POST /api/transmissions": [ok(#"{"error":"Fax sending is not configured"}"#, status: 503)]])
        let model = SendModel(session: try signedIn())
        model.choose(data: pdf, name: "a.pdf", pageCount: 1)
        model.draft.faxList = "2134147728"
        model.review()
        await model.send()
        #expect(model.step == .review && model.error == "Fax sending is not configured")
    }

    @Test func prefillUsesSenderSettingsOnce() async throws {
        StubProtocol.reset(["GET /api/settings": [ok(#"{"senderName":"Ada","mailFrom":{"firstName":"Ada","addressLine1":"1 Main St","city":"Austin","provinceOrState":"TX","postalOrZip":"78701","countryCode":"US"},"faxFrom":null}"#)]])
        let model = SendModel(session: try signedIn())
        await model.prefill()
        await model.prefill()
        #expect(model.draft.cover.from == "Ada" && model.draft.mailFrom.city == "Austin" && model.draft.cover.enabled)
        #expect(StubProtocol.requests.count == 1)
    }

    @Test func downloadedFileIsReadyOnlyAfterAuthenticatedFetch() async throws {
        StubProtocol.reset(["GET /api/inbound-faxes/f1/pdf": [Stub(status: 200, body: pdf, type: "application/pdf")]])
        let file = RemoteFile(session: try signedIn(), path: "/api/inbound-faxes/f1/pdf?inline=1", name: "Inbound fax.pdf")
        #expect(file.url == nil)
        await file.fetch()
        defer { WorkerAPI.clearDownloads() }
        #expect(file.url?.lastPathComponent == "Inbound fax.pdf")
        #expect(StubProtocol.requests.first?.authorization == "Bearer tok")
    }
}
}
