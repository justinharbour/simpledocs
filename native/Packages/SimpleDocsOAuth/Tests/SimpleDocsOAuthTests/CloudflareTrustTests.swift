import Foundation
import Testing
import SimpleDocsConnected
@testable import SimpleDocsOAuth

@Suite struct CloudflareTrustTests {
    func setup() throws -> (InstanceRegistry, ContextBinding, CloudflareTrust) {
        let origin = try InstanceOrigin.parse("https://instance.example.com").get()
        var registry = InstanceRegistry()
        let instance = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        let active = try registry.activate(instance.linkID)
        let binding = ContextBinding(active)
        return (registry, binding, try CloudflareTrust(registry: registry, binding: binding, configuredTeam: "https://team.cloudflareaccess.com"))
    }
    func resource(_ issuer: String = "https://team.cloudflareaccess.com") throws -> Data {
        try JSONSerialization.data(withJSONObject: ["resource": "https://instance.example.com/", "authorization_servers": [issuer]])
    }
    func issuer(_ team: String = "https://team.cloudflareaccess.com", token: String? = nil) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["issuer": team, "authorization_endpoint": team + "/cdn-cgi/access/oauth/authorization", "token_endpoint": token ?? team + "/cdn-cgi/access/oauth/token", "registration_endpoint": team + "/cdn-cgi/access/oauth/registration", "response_types_supported": ["code"], "grant_types_supported": ["authorization_code"], "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]])
    }
    @Test func acceptsConfiguredTeamAndRejectsSubstitution() throws {
        let (registry, _, trust) = try setup()
        try trust.validateResourceMetadata(resource(), registry: registry)
        let endpoints = try trust.validateIssuerMetadata(issuer(), registry: registry)
        #expect(endpoints.token.host == "team.cloudflareaccess.com")
        #expect(throws: DiscoveryError.invalidMetadata) { try trust.validateResourceMetadata(resource("https://other.cloudflareaccess.com"), registry: registry) }
        #expect(throws: DiscoveryError.invalidMetadata) { try trust.validateIssuerMetadata(issuer(token: "https://evil.example.com/token"), registry: registry) }
        #expect(throws: DiscoveryError.invalidMetadata) { try trust.validateIssuerMetadata(issuer("https://other.cloudflareaccess.com"), registry: registry) }
    }
    @Test func staleOrImpostorTeamRejected() throws {
        var (registry, binding, trust) = try setup()
        #expect(throws: DiscoveryError.invalidMetadata) { try CloudflareTrust(registry: registry, binding: binding, configuredTeam: "https://team.cloudflareaccess.com.evil.example") }
        let other = try InstanceOrigin.parse("https://other.example.com").get()
        let link = try registry.link(AcknowledgedOrigin(origin: other, acknowledgedDisplay: other.canonical)!)
        try registry.activate(link.linkID)
        #expect(throws: DiscoveryError.staleContext) { try trust.validateResourceMetadata(resource(), registry: registry) }
    }
    @Test func cloudflaredOnlyIsNotOAuthReadiness() throws {
        let (registry, _, trust) = try setup()
        for field in ["authentication_method", "authentication_methods"] {
            let method: Any = field == "authentication_method" ? "cloudflared" : ["cloudflared"]
            let data = try JSONSerialization.data(withJSONObject: ["resource": "https://instance.example.com", "protected": true,
                "authorization_servers": ["https://team.cloudflareaccess.com"], field: method])
            #expect(throws: DiscoveryError.oauthNotAdvertised) { try trust.validateResourceMetadata(data, registry: registry) }
        }
    }
}
