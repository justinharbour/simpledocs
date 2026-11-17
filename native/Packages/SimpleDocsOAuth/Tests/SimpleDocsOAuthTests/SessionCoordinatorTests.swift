import Foundation
import Testing
import SimpleDocsConnected
@testable import SimpleDocsOAuth

@MainActor @Suite struct SessionCoordinatorTests {
    func setup() throws -> (SessionCoordinator, LinkedInstance, LinkedInstance, ContextBinding) {
        var registry = InstanceRegistry()
        func ack(_ s: String) throws -> AcknowledgedOrigin {
            let origin = try InstanceOrigin.parse(s).get()
            return AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!
        }
        let first = try registry.link(ack("https://one.example.com"))
        let second = try registry.link(ack("https://two.example.com"))
        let binding = ContextBinding(try registry.activate(first.linkID))
        return (SessionCoordinator(registry: registry), first, second, binding)
    }

    @Test func confirmationRequiresExactValues() throws {
        let (owner, _, _, binding) = try setup()
        #expect(throws: CoordinatorError.confirmationRequired) {
            try IssuerConfirmation(registry: owner.registry, binding: binding,
                configuredIssuer: "https://team.cloudflareaccess.com", confirmedResource: "https://two.example.com",
                confirmedIssuer: "https://team.cloudflareaccess.com")
        }
        _ = try IssuerConfirmation(registry: owner.registry, binding: binding,
            configuredIssuer: "https://team.cloudflareaccess.com", confirmedResource: "https://one.example.com",
            confirmedIssuer: "https://team.cloudflareaccess.com")
    }

    @Test func switchingDiscardsLateMockResult() async throws {
        let (owner, _, second, binding) = try setup()
        var resume: CheckedContinuation<String, Never>?
        let task = Task { @MainActor in
            try await owner.run(binding: binding) {
                await withCheckedContinuation { resume = $0 }
            }
        }
        while resume == nil { await Task.yield() }
        try owner.activate(second.linkID)
        resume?.resume(returning: "late")
        await #expect(throws: CoordinatorError.staleContext) { try await task.value }
    }

    @Test func unlinkPurgesBeforeRemovalAndFailurePreservesLink() throws {
        let (owner, first, _, _) = try setup()
        enum Failure: Error { case purge }
        #expect(throws: Failure.self) { try owner.unlink(first.linkID) { _ in throw Failure.purge } }
        #expect(owner.registry.instances[first.linkID] != nil)
        var purged = false
        let receipt = try owner.unlink(first.linkID) { scope in
            #expect(scope == first.scope)
            purged = true
        }
        #expect(purged && owner.registry.instances[first.linkID] == nil)
        #expect(receipt.serverRevocation == .notAttempted)
    }

    @Test func registrationMetadataAndExpiration() throws {
        let registration = try PublicClientRegistration(name: "Simpledocs", callback: URL(string: "dev.example.app:/oauth/callback")!)
        let object = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(registration)) as? [String: Any])
        #expect(object["token_endpoint_auth_method"] as? String == "none")
        #expect(object["client_secret"] == nil)
        let tokens = OAuthTokens(accessToken: "synthetic", refreshToken: nil, expiresIn: 60, resource: "https://one.example.com/")
        let issued = Date(timeIntervalSince1970: 1000)
        let session = try ExpiringTokens(tokens: tokens, receivedAt: issued)
        #expect(try session.valid(at: issued).accessToken == "synthetic")
        #expect(throws: CoordinatorError.expired) { try session.valid(at: issued.addingTimeInterval(60)) }
    }
}
