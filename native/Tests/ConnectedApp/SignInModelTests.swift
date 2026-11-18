import Foundation
import XCTest
import SimpleDocsConnected
import SimpleDocsOAuth
@testable import simpledocs

@MainActor private final class MockAdapter: ConnectedFlowAdapter {
    var calls = 0
    var continuation: CheckedContinuation<Void, Never>?
    var suspended = false
    func resourceMetadata(url: URL) async throws -> Data {
        calls += 1
        if suspended { await withCheckedContinuation { continuation = $0 } }
        return Data(#"{"resource":"https://one.example.com","authorization_servers":["https://team.cloudflareaccess.com"]}"#.utf8)
    }
    func issuerMetadata(url: URL) async throws -> Data {
        try JSONSerialization.data(withJSONObject: ["issuer": "https://team.cloudflareaccess.com", "authorization_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization", "token_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token", "registration_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration", "response_types_supported": ["code"], "grant_types_supported": ["authorization_code"], "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]])
    }
    func register(url: URL, metadata: PublicClientRegistration) async throws -> Data {
        try JSONSerialization.data(withJSONObject: ["client_id": "test", "redirect_uris": metadata.redirect_uris, "token_endpoint_auth_method": "none"])
    }
    func authorize(url: URL, callbackScheme: String) async throws -> URL {
        let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
        var callback = URLComponents(string: "dev.justinharbour.simpledocs:/oauth/callback")!
        callback.queryItems = [.init(name: "code", value: "test"), .init(name: "state", value: state)]
        return callback.url!
    }
    func exchange(_ request: TokenRequest, registry: InstanceRegistry) async throws -> OAuthTokens {
        try request.parse(data: Data(#"{"access_token":"test","token_type":"Bearer","expires_in":60,"resource":"https://one.example.com/"}"#.utf8), registry: registry)
    }
    func send(plan: WorkerPlan, bearer: String) async throws -> Data {
        plan.url.path == "/api/inbound-faxes"
            ? Data(#"{"records":[{"id":"e1","faxId":"f1","occurredAt":"x","receivedAt":"2026-11-18T00:00:00Z"}],"pendingCount":0}"#.utf8)
            : Data(#"{"recordings":[]}"#.utf8)
    }
}

@MainActor final class SignInModelTests: XCTestCase {
    private func model(_ adapter: MockAdapter) -> SignInModel {
        let model = SignInModel(adapterFactory: { _ in adapter })
        model.instance = "https://one.example.com"
        model.issuer = "https://team.cloudflareaccess.com"
        return model
    }
    func testConfirmationRequiredAndAddressChangeInvalidates() async {
        let adapter = MockAdapter()
        let model = model(adapter)
        await model.signIn()
        XCTAssertEqual(adapter.calls, 0)
        model.prepare()
        XCTAssertEqual(model.preparation?.resource, "https://one.example.com")
        XCTAssertEqual(model.preparation?.issuer, "https://team.cloudflareaccess.com")
        XCTAssertEqual(adapter.calls, 0)
        model.issuer = "https://other.cloudflareaccess.com"
        XCTAssertNil(model.preparation)
        await model.signIn()
        XCTAssertEqual(adapter.calls, 0)
        model.prepare()
        model.instance = "https://two.example.com"
        XCTAssertNil(model.preparation)
    }
    func testMockSignInAndLocalSignOut() async {
        let adapter = MockAdapter()
        let model = model(adapter)
        model.prepare()
        await model.signIn()
        XCTAssertEqual(adapter.calls, 1)
        XCTAssertTrue(model.loaded)
        XCTAssertEqual(model.faxes.count, 1)
        model.signOut()
        XCTAssertNil(model.preparation)
        XCTAssertFalse(model.loaded)
        XCTAssertTrue(model.faxes.isEmpty)
    }
    func testSignOutCancelsAndDiscardsLateResult() async {
        let adapter = MockAdapter()
        adapter.suspended = true
        let model = model(adapter)
        model.prepare()
        let task = Task { await model.signIn() }
        while adapter.continuation == nil { await Task.yield() }
        XCTAssertTrue(model.busy)
        model.signOut()
        adapter.continuation?.resume()
        adapter.continuation = nil
        await task.value
        XCTAssertFalse(model.busy)
        XCTAssertNil(model.preparation)
        XCTAssertFalse(model.loaded)
    }
}
