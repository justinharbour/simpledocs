import Foundation
import Testing
@testable import SimpleDocsConnected

private func acknowledged(_ text: String) -> AcknowledgedOrigin {
    let origin = try! InstanceOrigin.parse(text).get()
    return AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!
}

@Suite struct SessionScopeTests {
    @Test func differentOriginsNeverShareNames() throws {
        let id = InstanceLinkID()
        let a = SessionScope(linkID: id, origin: acknowledged("https://a.example.com").origin)
        let b = SessionScope(linkID: id, origin: acknowledged("https://b.example.com").origin)
        #expect(a.keychainAccount != b.keychainAccount)
        #expect(a.cachePathComponents != b.cachePathComponents)
        #expect(a.idempotencyNamespace != b.idempotencyNamespace)
        #expect(a.originDigest != b.originDigest)
    }

    @Test func relinkingTheSameOriginGetsNewNames() {
        let origin = acknowledged("https://a.example.com").origin
        let first = SessionScope(linkID: InstanceLinkID(), origin: origin)
        let second = SessionScope(linkID: InstanceLinkID(), origin: origin)
        #expect(first.originDigest == second.originDigest)
        #expect(first.keychainAccount != second.keychainAccount)
        #expect(first.cachePathComponents != second.cachePathComponents)
        #expect(first.idempotencyNamespace != second.idempotencyNamespace)
    }

    @Test func namesAreStableAndFileSafe() {
        let id = InstanceLinkID(UUID(uuidString: "11111111-2222-3333-4444-555555555555")!)
        let scope = SessionScope(linkID: id, origin: acknowledged("https://a.example.com:8443").origin)
        #expect(scope.originDigest.count == 64)
        #expect(scope.keychainAccount == "instance-session.\(scope.originDigest).11111111-2222-3333-4444-555555555555")
        for component in scope.cachePathComponents {
            #expect(component.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") })
        }
        #expect(!scope.keychainAccount.contains("a.example.com"))
    }

    @Test func portIsPartOfTheScope() {
        let id = InstanceLinkID()
        let plain = SessionScope(linkID: id, origin: acknowledged("https://a.example.com").origin)
        let custom = SessionScope(linkID: id, origin: acknowledged("https://a.example.com:8443").origin)
        #expect(plain.originDigest != custom.originDigest)
    }
}

@Suite struct InstanceRegistryTests {
    @Test func linkingDoesNotSelectOrVerify() throws {
        var registry = InstanceRegistry()
        let linked = try registry.link(acknowledged("https://a.example.com"))
        #expect(registry.active == nil)
        #expect(linked.trust == .userEnteredUnverified)
    }

    @Test func duplicateOriginIsRejected() throws {
        var registry = InstanceRegistry()
        try registry.link(acknowledged("https://a.example.com"))
        #expect(throws: LinkError.alreadyLinked) { try registry.link(acknowledged("https://A.example.com:443/")) }
    }

    @Test func switchingStartsANewEpochAndStalesPendingWork() throws {
        var registry = InstanceRegistry()
        let a = try registry.link(acknowledged("https://a.example.com"))
        let b = try registry.link(acknowledged("https://b.example.com"))
        let contextA = try registry.activate(a.linkID)
        let pending = ContextBinding(contextA)
        #expect(registry.isCurrent(pending))
        let contextB = try registry.activate(b.linkID)
        #expect(contextB.epoch > contextA.epoch)
        #expect(!registry.isCurrent(pending))
        _ = try registry.activate(a.linkID)
        #expect(!registry.isCurrent(pending), "returning to the same instance must not revive earlier work")
    }

    @Test func reselectingTheActiveInstanceKeepsPendingWork() throws {
        var registry = InstanceRegistry()
        let a = try registry.link(acknowledged("https://a.example.com"))
        let context = try registry.activate(a.linkID)
        let pending = ContextBinding(context)
        _ = try registry.activate(a.linkID)
        #expect(registry.isCurrent(pending))
    }

    @Test func unlinkPurgesEverythingAndDoesNotClaimRevocation() throws {
        var registry = InstanceRegistry()
        let a = try registry.link(acknowledged("https://a.example.com"))
        let context = try registry.activate(a.linkID)
        let pending = ContextBinding(context)
        let receipt = try registry.unlink(a.linkID)
        #expect(Set(receipt.purge) == Set(PurgeItem.allCases))
        #expect(receipt.serverRevocation == .notAttempted)
        #expect(receipt.scope == a.scope)
        #expect(registry.active == nil)
        #expect(!registry.isCurrent(pending))
        #expect(throws: LinkError.notLinked) { try registry.unlink(a.linkID) }
        #expect(throws: LinkError.notLinked) { try registry.activate(a.linkID) }
    }

    @Test func relinkAfterUnlinkIsADifferentLink() throws {
        var registry = InstanceRegistry()
        let first = try registry.link(acknowledged("https://a.example.com"))
        _ = try registry.unlink(first.linkID)
        let second = try registry.link(acknowledged("https://a.example.com"))
        #expect(first.linkID != second.linkID)
        #expect(first.scope.keychainAccount != second.scope.keychainAccount)
    }

    @Test func duplicateLinkIDCannotReplaceTheActiveInstance() throws {
        var registry = InstanceRegistry()
        let a = try registry.link(acknowledged("https://a.example.com"))
        let context = try registry.activate(a.linkID)
        let pending = ContextBinding(context)
        let before = registry
        #expect(throws: LinkError.linkIDReused) {
            try registry.link(acknowledged("https://b.example.com"), id: a.linkID)
        }
        #expect(registry == before, "a refused link must not change any state")
        #expect(registry.active == context)
        #expect(registry.active?.scope.origin == a.origin)
        #expect(registry.instances[a.linkID]?.origin == a.origin)
        #expect(registry.isCurrent(pending))
    }

    @Test func duplicateLinkIDWithSameOriginIsAlsoRefused() throws {
        var registry = InstanceRegistry()
        let a = try registry.link(acknowledged("https://a.example.com"))
        #expect(throws: LinkError.linkIDReused) {
            try registry.link(acknowledged("https://a.example.com"), id: a.linkID)
        }
    }

    @Test func duplicateLinkIDWithOtherInactiveInstance() throws {
        var registry = InstanceRegistry()
        let a = try registry.link(acknowledged("https://a.example.com"))
        let b = try registry.link(acknowledged("https://b.example.com"))
        _ = try registry.activate(a.linkID)
        #expect(throws: LinkError.linkIDReused) {
            try registry.link(acknowledged("https://c.example.com"), id: b.linkID)
        }
        #expect(registry.instances[b.linkID]?.origin == b.origin)
        #expect(registry.instances.count == 2)
    }

    @Test func unlinkedLinkIDCannotBeReused() throws {
        var registry = InstanceRegistry()
        let a = try registry.link(acknowledged("https://a.example.com"))
        let pending = ContextBinding(try registry.activate(a.linkID))
        _ = try registry.unlink(a.linkID)
        for origin in ["https://a.example.com", "https://b.example.com"] {
            #expect(throws: LinkError.linkIDReused) {
                try registry.link(acknowledged(origin), id: a.linkID)
            }
        }
        #expect(registry.instances.isEmpty)
        #expect(registry.active == nil)
        #expect(!registry.isCurrent(pending))
        // Selecting the stale ID must not bring anything back.
        #expect(throws: LinkError.notLinked) { try registry.activate(a.linkID) }
    }

    @Test func refusedDuplicateOriginDoesNotConsumeTheID() throws {
        var registry = InstanceRegistry()
        _ = try registry.link(acknowledged("https://a.example.com"))
        let fresh = InstanceLinkID()
        #expect(throws: LinkError.alreadyLinked) {
            try registry.link(acknowledged("https://a.example.com"), id: fresh)
        }
        let b = try registry.link(acknowledged("https://b.example.com"), id: fresh)
        #expect(b.linkID == fresh)
    }

    @Test func generatedIDsAreDistinct() throws {
        var registry = InstanceRegistry()
        var seen = Set<InstanceLinkID>()
        for index in 0..<50 {
            let linked = try registry.link(acknowledged("https://h\(index).example.com"))
            #expect(seen.insert(linked.linkID).inserted)
        }
    }

    @Test func unlinkingAnotherInstanceKeepsActivePendingWork() throws {
        var registry = InstanceRegistry()
        let a = try registry.link(acknowledged("https://a.example.com"))
        let b = try registry.link(acknowledged("https://b.example.com"))
        let pending = ContextBinding(try registry.activate(a.linkID))
        _ = try registry.unlink(b.linkID)
        #expect(registry.isCurrent(pending))
    }
}

@Suite struct CredentialPolicyTests {
    private func registry(active: Bool = true) throws -> (InstanceRegistry, LinkedInstance) {
        var registry = InstanceRegistry()
        let instance = try registry.link(acknowledged("https://a.example.com"))
        if active { _ = try registry.activate(instance.linkID) }
        return (registry, instance)
    }

    @Test func nativeAuthIsNotVerified() {
        #expect(NativeAuthStatus.current == .unknown)
    }

    @Test func noInstanceSelectedIsDenied() throws {
        let (registry, _) = try registry(active: false)
        #expect(CredentialPolicy.evaluate(target: URL(string: "https://a.example.com/api/v1/capabilities")!, registry: registry) == .noActiveInstance)
        #expect(CredentialPolicy.evaluate(target: URL(string: "https://a.example.com/")!, registry: InstanceRegistry()) == .noActiveInstance)
    }

    @Test func sameOriginRequestIsStillDeniedWhileAuthIsUnknown() throws {
        let (registry, _) = try registry()
        let target = URL(string: "https://a.example.com/api/v1/capabilities")!
        #expect(CredentialPolicy.evaluate(target: target, registry: registry) == .authenticationNotVerified)
        #expect(CredentialPolicy.evaluate(target: target, registry: registry, auth: .unknown) == .authenticationNotVerified)
        #expect(CredentialPolicy.evaluate(target: target, registry: registry, auth: .unsupported) == .authenticationNotVerified)
    }

    @Test func otherOriginIsReportedAsMismatch() throws {
        let (registry, _) = try registry()
        for text in ["https://b.example.com/", "http://a.example.com/", "https://a.example.com:8443/", "https://a.example.com.evil.example/"] {
            #expect(CredentialPolicy.evaluate(target: URL(string: text)!, registry: registry) == .originMismatch, "\(text)")
        }
    }

    @Test func staleContextIsDenied() throws {
        var (registry, a) = try registry()
        let b = try registry.link(acknowledged("https://b.example.com"))
        let pending = ContextBinding(registry.active!)
        _ = try registry.activate(b.linkID)
        #expect(CredentialPolicy.evaluate(target: URL(string: "https://b.example.com/")!, pending: pending, registry: registry) == .staleContext)
        _ = a
    }

    @Test func redirectsToAnotherOriginAreDenied() throws {
        let (registry, _) = try registry()
        let source = URL(string: "https://a.example.com/api/v1/jobs")!
        #expect(CredentialPolicy.evaluateRedirect(from: source, to: URL(string: "https://evil.example/")!, registry: registry) == .originMismatch)
        #expect(CredentialPolicy.evaluateRedirect(from: source, to: URL(string: "http://a.example.com/")!, registry: registry) == .originMismatch)
        #expect(CredentialPolicy.evaluateRedirect(from: URL(string: "https://evil.example/")!, to: source, registry: registry) == .originMismatch)
        #expect(CredentialPolicy.evaluateRedirect(from: source, to: URL(string: "https://a.example.com/login")!, registry: registry) == .authenticationNotVerified)
    }

    @Test func everyDenialExplainsItself() {
        for denial in [CredentialDenial.noActiveInstance, .staleContext, .originMismatch, .authenticationNotVerified] {
            #expect(!denial.message.isEmpty)
        }
    }
}

@Suite struct NoOverclaimTests {
    @Test func trustHasNoVerifiedState() {
        let mirror = String(describing: InstanceTrust.userEnteredUnverified)
        #expect(mirror == "userEnteredUnverified")
        #expect(!String(describing: NativeAuthStatus.current).lowercased().contains("verified"))
    }

    @Test func noOwnerEndpointIsBuiltIn() {
        let samples = [InstanceOriginError.empty.message, CredentialDenial.authenticationNotVerified.message]
        for text in samples { #expect(!text.contains("justinharbour")) }
    }
}
