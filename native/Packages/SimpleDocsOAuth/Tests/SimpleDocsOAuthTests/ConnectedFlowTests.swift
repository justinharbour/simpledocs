import Foundation
import Testing
import SimpleDocsConnected
@testable import SimpleDocsOAuth

@MainActor final class MockFlow: ConnectedFlowAdapter {
    var registrationResource = ""
    var sentURL: URL?
    var sentBearer: String?
    var substituteTeam = false
    func resourceMetadata(url: URL) async throws -> Data {
        Data("{\"resource\":\"https://one.example.com\",\"authorization_servers\":[\"https://\(substituteTeam ? "evil" : "team").cloudflareaccess.com\"]}".utf8)
    }
    func issuerMetadata(url: URL) async throws -> Data {
        try JSONSerialization.data(withJSONObject: ["issuer": "https://team.cloudflareaccess.com", "authorization_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization", "token_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token", "registration_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration", "response_types_supported": ["code"], "grant_types_supported": ["authorization_code"], "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]])
    }
    func register(url: URL, metadata: PublicClientRegistration) async throws -> Data {
        registrationResource = metadata.resource
        return try JSONSerialization.data(withJSONObject: ["client_id": "synthetic", "redirect_uris": metadata.redirect_uris, "token_endpoint_auth_method": "none"])
    }
    func authorize(url: URL, callbackScheme: String) async throws -> URL {
        let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
        var callback = URLComponents(string: "dev.example.app:/oauth/callback")!
        callback.queryItems = [URLQueryItem(name: "code", value: "synthetic"), URLQueryItem(name: "state", value: state)]
        return callback.url!
    }
    func exchange(_ request: TokenRequest, registry: InstanceRegistry) async throws -> OAuthTokens {
        try request.parse(data: Data(#"{"access_token":"synthetic","token_type":"Bearer","expires_in":60,"resource":"https://one.example.com/"}"#.utf8), registry: registry)
    }
    func send(plan: WorkerPlan, bearer: String) async throws -> Data {
        sentURL = plan.url; sentBearer = bearer
        return Data("{}".utf8)
    }
}

@MainActor @Suite struct ConnectedFlowTests {
    func setup() throws -> (SessionCoordinator, ConnectedFlow, MockFlow, IssuerConfirmation, ContextBinding, LinkedInstance) {
        var registry = InstanceRegistry()
        let origin = try InstanceOrigin.parse("https://one.example.com").get()
        let link = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        let otherOrigin = try InstanceOrigin.parse("https://two.example.com").get()
        let other = try registry.link(AcknowledgedOrigin(origin: otherOrigin, acknowledgedDisplay: otherOrigin.canonical)!)
        let binding = ContextBinding(try registry.activate(link.linkID))
        let confirmation = try IssuerConfirmation(registry: registry, binding: binding, configuredIssuer: "https://team.cloudflareaccess.com", confirmedResource: origin.canonical, confirmedIssuer: "https://team.cloudflareaccess.com")
        let owner = SessionCoordinator(registry: registry)
        let mock = MockFlow()
        return (owner, ConnectedFlow(owner: owner, adapter: mock), mock, confirmation, binding, other)
    }
    @Test func mockSignInAndScopedAPIAndExpiry() async throws {
        let (_, flow, mock, confirmation, binding, _) = try setup()
        let now = Date(timeIntervalSince1970: 1000)
        try await flow.signIn(confirmation: confirmation, binding: binding, callback: URL(string: "dev.example.app:/oauth/callback")!, now: { now })
        #expect(mock.registrationResource == "https://one.example.com")
        _ = try await flow.perform(.readFax(UUID()), now: now)
        #expect(mock.sentURL?.host == "one.example.com")
        #expect(mock.sentBearer == "synthetic")
        await #expect(throws: CoordinatorError.expired) { try await flow.perform(.readFax(UUID()), now: now.addingTimeInterval(60)) }
    }
    @Test func substitutionAndSwitchFailClosed() async throws {
        let (owner, flow, mock, confirmation, binding, other) = try setup()
        mock.substituteTeam = true
        await #expect(throws: DiscoveryError.invalidMetadata) { try await flow.signIn(confirmation: confirmation, binding: binding, callback: URL(string: "dev.example.app:/oauth/callback")!) }
        #expect(mock.registrationResource.isEmpty)
        mock.substituteTeam = false
        try await flow.signIn(confirmation: confirmation, binding: binding, callback: URL(string: "dev.example.app:/oauth/callback")!)
        try owner.activate(other.linkID)
        await #expect(throws: ConnectedFlowError.self) { try await flow.perform(.readFax(UUID())) }
        #expect(mock.sentURL == nil)
    }
}
