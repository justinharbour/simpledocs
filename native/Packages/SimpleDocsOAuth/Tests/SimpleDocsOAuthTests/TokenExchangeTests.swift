import Foundation
import Testing
import SimpleDocsConnected
@testable import SimpleDocsOAuth

@MainActor @Suite struct TokenExchangeTests {
    func plan() throws -> (InstanceRegistry, TokenRequest) {
        let origin = try InstanceOrigin.parse("https://instance.example.com").get()
        var registry = InstanceRegistry()
        let instance = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        let binding = ContextBinding(try registry.activate(instance.linkID))
        let trust = try CloudflareTrust(registry: registry, binding: binding, configuredTeam: "https://team.cloudflareaccess.com")
        let metadata = try JSONSerialization.data(withJSONObject: ["issuer": "https://team.cloudflareaccess.com", "authorization_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization", "token_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token", "registration_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration", "response_types_supported": ["code"], "grant_types_supported": ["authorization_code"], "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]])
        let endpoints = try trust.validateIssuerMetadata(metadata, registry: registry)
        let tx = try ManagedOAuthTransaction(registry: registry, binding: binding, authorizationEndpoint: endpoints.authorization,
                                              tokenEndpoint: endpoints.token, callback: URL(string: "com.example.simpledocs:/oauth/callback")!, clientID: "client")
        let query = try #require(URLComponents(url: tx.authorizationURL, resolvingAgainstBaseURL: false)?.queryItems)
        let state = try #require(query.first { $0.name == "state" }?.value)
        var callback = URLComponents(string: "com.example.simpledocs:/oauth/callback")!
        callback.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "code", value: "a+b&c")]
        let exchange = try tx.consume(callbackURL: #require(callback.url), registry: registry)
        return (registry, try TokenRequest(exchange: exchange, endpoints: endpoints, registry: registry))
    }
    @Test func formEncodingAndValidResponse() throws {
        let (registry, plan) = try plan()
        let body = try #require(String(data: plan.body, encoding: .utf8))
        #expect(body.contains("code=a%2Bb%26c"))
        #expect(body.contains("code_verifier="))
        let data = Data(#"{"access_token":"synthetic","token_type":"Bearer","expires_in":900,"resource":"https://instance.example.com/"}"#.utf8)
        #expect(try plan.parse(data: data, registry: registry).accessToken == "synthetic")
    }
    @Test func rejectsWrongResourceAndStaleContext() throws {
        var (registry, plan) = try plan()
        let data = Data(#"{"access_token":"synthetic","token_type":"Bearer","expires_in":900,"resource":"https://other.example.com/"}"#.utf8)
        #expect(throws: ExchangeError.invalidResponse) { try plan.parse(data: data, registry: registry) }
        let other = try InstanceOrigin.parse("https://other.example.com").get()
        let instance = try registry.link(AcknowledgedOrigin(origin: other, acknowledgedDisplay: other.canonical)!)
        try registry.activate(instance.linkID)
        #expect(throws: ExchangeError.staleContext) { try plan.parse(data: data, registry: registry) }
    }
}
