import Foundation
import Testing
@testable import SimpleDocsCore

@Suite struct InstanceAddressTests {
    @Test func emptyInput() {
        #expect(InstanceAddress.check("") == .empty)
        #expect(InstanceAddress.check("   ") == .empty)
    }

    @Test func acceptsHttpsOriginAndNormalizes() {
        guard case .wellFormed(let url) = InstanceAddress.check(" https://Docs.Example.com/ ") else {
            Issue.record("expected well formed"); return
        }
        #expect(url.absoluteString == "https://docs.example.com")
        guard case .wellFormed(let withPort) = InstanceAddress.check("https://docs.example.com:8443") else {
            Issue.record("expected well formed"); return
        }
        #expect(withPort.port == 8443)
    }

    @Test(arguments: [
        "http://docs.example.com",
        "docs.example.com",
        "ftp://docs.example.com",
        "https://",
        "https://user:pass@docs.example.com",
        "https://docs.example.com/app",
        "https://docs.example.com?x=1",
        "https://docs.example.com#frag",
        "https://docs example.com",
        "https://docs.example.com:99999",
    ])
    func rejectsUnsafeOrMalformed(_ input: String) {
        #expect(!InstanceAddress.check(input).isWellFormed)
    }

    @Test func wellFormedIsNotClaimedToBeAnInstance() {
        let check = InstanceAddress.check("https://docs.example.com")
        #expect(check.message.contains("not known to be a simpledocs instance"))
    }

    @Test func noOwnerEndpointIsBuiltIn() {
        let text = (AppEdition.allCases.flatMap(\.limitations)
            + InstanceOnboarding.steps.map(\.detail)
            + AppEdition.allCases.map(\.summary)).joined(separator: " ")
        #expect(!text.contains("justinharbour"))
        #expect(!text.contains("simpledocs.justinharbour.dev"))
    }
}

@Suite struct OnboardingTests {
    @Test func everyStepIsMarkedUnavailableAndExplained() {
        #expect(InstanceOnboarding.steps.count >= 4)
        for step in InstanceOnboarding.steps {
            #expect(!step.detail.isEmpty)
            #expect([.notImplemented, .notPublished, .undecided].contains(step.status))
        }
    }

    @Test func signInIsUndecidedAndDeploymentIsNotPublished() {
        let byID = Dictionary(uniqueKeysWithValues: InstanceOnboarding.steps.map { ($0.id, $0) })
        #expect(byID["signin"]?.status == .undecided)
        #expect(byID["deploy"]?.status == .notPublished)
    }

    @Test func stepIDsAreUnique() {
        let ids = InstanceOnboarding.steps.map(\.id)
        #expect(Set(ids).count == ids.count)
    }
}
