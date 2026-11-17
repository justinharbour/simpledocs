import Foundation
import Testing
import SimpleDocsConnected
@testable import SimpleDocsOAuth

@Suite struct DiscoveryTests {
    private func setup() throws -> (InstanceRegistry, ContextBinding) {
        let origin = try InstanceOrigin.parse("https://instance.example.com").get()
        var registry = InstanceRegistry()
        let instance = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        let context = try registry.activate(instance.linkID)
        return (registry, ContextBinding(context))
    }
    private func document(issuer: String = "https://instance.example.com", authorization: String = "https://instance.example.com/authorize", token: String = "https://instance.example.com/token", methods: [String] = ["S256"], auth: [String] = ["none"]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["issuer": issuer, "authorization_endpoint": authorization, "token_endpoint": token, "response_types_supported": ["code"], "code_challenge_methods_supported": methods, "token_endpoint_auth_methods_supported": auth])
    }
    @Test func acceptsConservativeMetadata() throws {
        let (registry, binding) = try setup()
        let metadata = try OAuthMetadata.validate(data: document(), registry: registry, binding: binding)
        #expect(metadata.issuer == "https://instance.example.com")
        #expect(metadata.binding == binding)
    }
    @Test func rejectsEndpointAndIssuerSubstitution() throws {
        let (registry, binding) = try setup()
        for data in [try document(issuer: "https://evil.example.com"),
                     try document(authorization: "https://evil.example.com/authorize"),
                     try document(token: "https://instance.example.com.evil.example/token"),
                     try document(token: "http://instance.example.com/token"),
                     try document(token: "https://user@instance.example.com/token"),
                     try document(token: "https://instance.example.com/token?x=1")] {
            #expect(throws: DiscoveryError.invalidMetadata) { try OAuthMetadata.validate(data: data, registry: registry, binding: binding) }
        }
    }
    @Test func rejectsMissingSecurityCapabilitiesAndOversizedData() throws {
        let (registry, binding) = try setup()
        #expect(throws: DiscoveryError.invalidMetadata) { try OAuthMetadata.validate(data: document(methods: ["plain"]), registry: registry, binding: binding) }
        #expect(throws: DiscoveryError.invalidMetadata) { try OAuthMetadata.validate(data: document(auth: ["client_secret_basic"]), registry: registry, binding: binding) }
        #expect(throws: DiscoveryError.responseTooLarge) { try OAuthMetadata.validate(data: Data(repeating: 32, count: 65_537), registry: registry, binding: binding) }
    }
    @Test func staleBindingRejected() throws {
        var (registry, binding) = try setup()
        let origin = try InstanceOrigin.parse("https://other.example.com").get()
        let other = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        try registry.activate(other.linkID)
        #expect(throws: DiscoveryError.staleContext) { try OAuthMetadata.validate(data: document(), registry: registry, binding: binding) }
    }
}
