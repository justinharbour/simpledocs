import Foundation
import Testing
@testable import SimpleDocsConnected

@Suite struct PushRegistrationTests {
    @Test func tokenIsBoundToTheActiveInstanceAndEpoch() throws {
        var registry = InstanceRegistry()
        let first = try InstanceOrigin.parse("https://one.example.com").get()
        let second = try InstanceOrigin.parse("https://two.example.com").get()
        let one = try registry.link(AcknowledgedOrigin(origin: first, acknowledgedDisplay: first.canonical)!)
        let two = try registry.link(AcknowledgedOrigin(origin: second, acknowledgedDisplay: second.canonical)!)
        let binding = ContextBinding(try registry.activate(one.linkID))
        let token = try PendingPushToken(Data([1, 2, 3]), binding: binding, registry: registry)
        #expect(try token.token(registry: registry) == Data([1, 2, 3]))
        _ = try registry.activate(two.linkID)
        #expect(throws: PushRegistrationError.staleContext) { try token.token(registry: registry) }
        _ = try registry.activate(one.linkID)
        #expect(throws: PushRegistrationError.staleContext) { try token.token(registry: registry) }
    }

    @Test func rejectsEmptyOversizedAndStaleTokens() throws {
        var registry = InstanceRegistry()
        let origin = try InstanceOrigin.parse("https://one.example.com").get()
        let link = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        let binding = ContextBinding(try registry.activate(link.linkID))
        #expect(throws: PushRegistrationError.invalidToken) { try PendingPushToken(Data(), binding: binding, registry: registry) }
        #expect(throws: PushRegistrationError.invalidToken) { try PendingPushToken(Data(repeating: 1, count: 257), binding: binding, registry: registry) }
        _ = try registry.unlink(link.linkID)
        #expect(throws: PushRegistrationError.staleContext) { try PendingPushToken(Data([1]), binding: binding, registry: registry) }
    }
}
