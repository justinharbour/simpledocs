import Foundation
import Testing
@testable import SimpleDocsConnected

@Suite struct WorkerOperationsTests {
    private let id = UUID(uuidString: "ba8b94b2-8b67-41a4-a933-c93b4f61a001")!

    private func setup(_ hostname: String = "a.example.com") throws -> (InstanceRegistry, ContextBinding) {
        let origin = try InstanceOrigin.parse("https://\(hostname)").get()
        var registry = InstanceRegistry()
        let link = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        let context = try registry.activate(link.linkID)
        return (registry, ContextBinding(context))
    }

    @Test func buildsActualWorkerRoutesWithoutCredentials() throws {
        let (registry, binding) = try setup()
        let draft = try WorkerPlanner.plan(.readMailDraft(id), binding: binding, registry: registry)
        let fax = try WorkerPlanner.plan(.readFax(id), binding: binding, registry: registry)
        #expect(draft.url.absoluteString == "https://a.example.com/api/mail-drafts/\(id.uuidString.lowercased())")
        #expect(fax.url.path == "/api/faxes/\(id.uuidString.lowercased())")
        #expect(draft.method == "GET" && draft.body == nil && draft.contentType == nil)
        #expect(draft.isCurrent(in: registry))
        #expect(CredentialPolicy.evaluate(target: draft.url, pending: binding, registry: registry) == .authenticationNotVerified)
    }

    @Test func saveUsesWorkerRevisionAndObjectContract() throws {
        let (registry, binding) = try setup()
        let plan = try WorkerPlanner.plan(.saveMailDraft(id, revision: 2, content: Data(#"{"subject":"Sample"}"#.utf8)), binding: binding, registry: registry)
        let body = try #require(plan.body)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(plan.method == "PUT" && plan.contentType == "application/json")
        #expect(json["revision"] as? Int == 2)
        #expect((json["content"] as? [String: String])?["subject"] == "Sample")
    }

    @Test func plansPushDeviceRegistration() throws {
        let (registry, binding) = try setup()
        let token = String(repeating: "ab", count: 32)
        let register = try WorkerPlanner.plan(.registerPushDevice(token: token, platform: .macos, environment: .sandbox), binding: binding, registry: registry)
        let body = try #require(register.body)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(register.url.absoluteString == "https://a.example.com/api/push/devices")
        #expect(register.method == "POST" && register.contentType == "application/json")
        #expect(json == ["token": token, "platform": "macos", "environment": "sandbox"])
        for bad in ["", "abc", String(repeating: "A", count: 64), String(repeating: "g", count: 64), String(repeating: "a", count: 201), token + "/x"] {
            #expect(throws: WorkerPlanError.invalidIdentifier) { try WorkerPlanner.plan(.registerPushDevice(token: bad, platform: .ios, environment: .production), binding: binding, registry: registry) }
        }
    }

    @Test func rejectsBadInput() throws {
        let (registry, binding) = try setup()
        let invalidID = UUID(uuidString: "ba8b94b2-8b67-11a4-a933-c93b4f61a001")!
        #expect(throws: WorkerPlanError.invalidIdentifier) { try WorkerPlanner.plan(.readFax(invalidID), binding: binding, registry: registry) }
        for content in ["[]", "null", "not-json"] {
            #expect(throws: WorkerPlanError.invalidDraft) { try WorkerPlanner.plan(.saveMailDraft(id, revision: 0, content: Data(content.utf8)), binding: binding, registry: registry) }
        }
        #expect(throws: WorkerPlanError.invalidDraft) { try WorkerPlanner.plan(.saveMailDraft(id, revision: -1, content: Data("{}".utf8)), binding: binding, registry: registry) }
        let oversized = Data(("{\"value\":\"" + String(repeating: "x", count: 65_536) + "\"}").utf8)
        #expect(throws: WorkerPlanError.draftTooLarge) { try WorkerPlanner.plan(.saveMailDraft(id, revision: 0, content: oversized), binding: binding, registry: registry) }
    }

    @Test func switchingOrUnlinkingInvalidatesPlansEvenAfterSwitchingBack() throws {
        var (registry, binding) = try setup()
        let plan = try WorkerPlanner.plan(.readFax(id), binding: binding, registry: registry)
        let first = try #require(registry.active?.scope.linkID)
        let origin = try InstanceOrigin.parse("https://b.example.com").get()
        let second = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        try registry.activate(second.linkID)
        #expect(!plan.isCurrent(in: registry))
        #expect(throws: WorkerPlanError.staleContext) { try WorkerPlanner.plan(.readFax(id), binding: binding, registry: registry) }
        try registry.activate(first)
        #expect(!plan.isCurrent(in: registry))
        _ = try registry.unlink(first)
        #expect(!plan.isCurrent(in: registry))
    }

    @Test func faxAcceptanceNeverMeansDelivered() {
        #expect(FaxReadStatus(serverValue: "accepted") == .accepted)
        #expect(FaxReadStatus(serverValue: "delivered") == .delivered)
        #expect(FaxReadStatus(serverValue: "new-provider-status") == .unknown)
    }

    @Test func customPortIsPreservedAndOtherRegistriesCannotUsePlan() throws {
        let (registry, binding) = try setup("a.example.com:8443")
        let plan = try WorkerPlanner.plan(.readFax(id), binding: binding, registry: registry)
        #expect(plan.url.absoluteString.hasPrefix("https://a.example.com:8443/"))
        let (other, _) = try setup("a.example.com:8443")
        #expect(!plan.isCurrent(in: other))
    }

    @Test func encodedEnvelopeMustFitServerLimit() throws {
        let (registry, binding) = try setup()
        // The input object alone fits, but the required revision envelope does not.
        let content = Data(("{\"value\":\"" + String(repeating: "x", count: 65_515) + "\"}").utf8)
        #expect(content.count < 65_536)
        #expect(throws: WorkerPlanError.draftTooLarge) {
            try WorkerPlanner.plan(.saveMailDraft(id, revision: 0, content: content), binding: binding, registry: registry)
        }
    }
}
