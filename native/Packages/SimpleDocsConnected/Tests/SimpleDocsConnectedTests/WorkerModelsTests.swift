import Foundation
import Testing
@testable import SimpleDocsConnected

@Suite struct WorkerModelsTests {
    @Test func decodesMixedRecords() throws {
        let json = #"""
        {"records":[
          {"type":"transmission","id":"t1","title":"Lease","createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:01:00.000Z","pageCount":3,
           "channels":[{"id":"d1","channel":"fax","status":"accepted"},{"id":"d2","channel":"mail","status":"awaiting_approval"}],
           "previewUrl":"/api/transmissions/t1/document","previewType":"pdf"},
          {"type":"inbound_fax","id":"f1","title":"Inbound fax","createdAt":"2026-11-15T10:00:00Z","updatedAt":"2026-11-15T10:00:00Z",
           "channels":[{"channel":"fax","status":"received"}],"previewUrl":"/api/inbound-faxes/f1/pdf?inline=1","previewType":"pdf"},
          {"type":"recording","id":"r1","title":"Voicemail","createdAt":"2026-11-14T10:00:00Z","updatedAt":"2026-11-14T10:00:00Z","kind":"voicemail",
           "direction":"inbound","fromNumber":"+12134147728","toNumber":"+15125550100","durationSecs":42,"transcript":"Hello",
           "channels":[{"channel":"voice","status":"unheard"}],"previewUrl":"/api/voice/recordings/r1","previewType":"audio"},
          {"type":"future_kind","id":"x","title":"?","createdAt":"2026-11-13T10:00:00Z","channels":[]}
        ]}
        """#
        let records = try JSONDecoder().decode(RecordsResponse.self, from: Data(json.utf8)).records
        #expect(records.map(\.type) == [.transmission, .inboundFax, .recording, .other])
        #expect(records[0].channels.map(\.status) == ["accepted", "awaiting_approval"])
        #expect(records[0].pageCount == 3)
        #expect(records[2].transcript == "Hello")
        #expect(records[0].date != nil)
    }

    @Test func activeMeansNonTerminalAndNotAwaitingApproval() throws {
        func record(_ statuses: [String]) throws -> RecordItem {
            let channels = statuses.map { #"{"channel":"fax","status":"\#($0)"}"# }.joined(separator: ",")
            return try JSONDecoder().decode(RecordItem.self, from: Data(#"{"type":"transmission","id":"t","title":"T","createdAt":"2026-01-01T00:00:00Z","channels":[\#(channels)]}"#.utf8))
        }
        #expect(try record(["queued"]).isActive)
        #expect(try record(["delivered", "accepted"]).isActive)
        #expect(try !record(["delivered", "failed", "completed"]).isActive)
        #expect(try !record(["awaiting_approval"]).isActive)
    }

    @Test func parsesBothWorkerDateFormats() {
        let iso = WorkerDate.parse("2026-11-16T10:00:00.250Z")
        let sql = WorkerDate.parse("2026-11-16 10:00:00")
        #expect(iso != nil)
        #expect(sql == WorkerDate.parse("2026-11-16T10:00:00Z"))
        #expect(WorkerDate.parse("not a date") == nil)
    }

    @Test func decodesSnakeCaseRecordings() throws {
        let json = #"{"recordings":[{"recording_id":"r1","archived_at":"2026-11-16 10:00:00","kind":"voicemail","direction":"inbound","from_number":"+12134147728","to_number":null,"duration_secs":12,"heard_at":null,"transcript":null}]}"#
        let recording = try #require(JSONDecoder().decode(RecordingsResponse.self, from: Data(json.utf8)).recordings.first)
        #expect(recording.isNew)
        #expect(recording.path == "/api/voice/recordings/r1")
        #expect(recording.date != nil)
    }

    @Test func callsDialTheOtherParty() throws {
        let json = #"{"calls":[{"id":"c1","direction":"inbound","from":"+12134147728","to":"+15125550100","startedAt":"2026-11-16T10:00:00Z","answeredAt":null,"endedAt":null,"durationSecs":null,"hangupCause":null,"outcome":"missed"},{"id":"c2","direction":"outbound","from":"+15125550100","to":"+12134147728","startedAt":"2026-11-16T09:00:00Z","answeredAt":null,"endedAt":null,"durationSecs":null,"hangupCause":null,"outcome":"no answer"}]}"#
        let calls = try JSONDecoder().decode(CallsResponse.self, from: Data(json.utf8)).calls
        #expect(calls.map(\.otherParty) == ["+12134147728", "+12134147728"])
    }

    @Test func voicemailSettingsUseWireNames() throws {
        let value = VoicemailSettings(greeting: "Hi", voice: "Telnyx.KokoroTTS.af", serviceLevel: "basic")
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: String])
        #expect(object == ["greeting": "Hi", "voice": "Telnyx.KokoroTTS.af", "service_level": "basic"])
        let decoded = try JSONDecoder().decode(VoicemailSettings.self, from: Data(#"{"greeting":"A","voice":"female","service_level":"basic"}"#.utf8))
        #expect(decoded.voice == "female")
    }

    @Test func voicePresetsCoverTheDocumentedVoices() {
        #expect(VoicePreset.all.map(\.id) == ["Telnyx.KokoroTTS.af", "AWS.Polly.Joanna-Neural", "AWS.Polly.Joanna", "female"])
        #expect(VoicePreset.preset(for: "AWS.Polly.Joanna-Neural")?.serviceLevel == "premium")
        #expect(VoicePreset.preset(for: "custom.voice") == nil)
        #expect(VoicePreset.greetingLimit == 1000)
    }

    @Test func contactOmitsEmptyOptionalsAndUppercasesState() throws {
        var contact = MailContact()
        contact.firstName = " Ada "; contact.addressLine1 = "1 Main St"; contact.city = "Austin"; contact.provinceOrState = "tx"; contact.postalOrZip = "78701"
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(contact)) as? [String: String])
        #expect(object["lastName"] == nil && object["addressLine2"] == nil)
        #expect(object["firstName"] == "Ada" && object["provinceOrState"] == "TX" && object["countryCode"] == "US")
        #expect(contact.problem("To") == nil)
        contact.postalOrZip = "7870"
        #expect(contact.problem("To")?.contains("ZIP") == true)
        contact.provinceOrState = "Texas"
        #expect(contact.problem("To")?.contains("state") == true)
    }

    @Test func settingsDecodeWithoutReturnAddress() throws {
        let value = try JSONDecoder().decode(WorkerSettings.self, from: Data(#"{"senderName":"Me","mailFrom":null,"faxFrom":"+15125550100"}"#.utf8))
        #expect(value.mailFrom == nil && value.faxFrom == "+15125550100")
    }
}
