import AuthenticationServices
import Foundation
import Testing
import SimpleDocsConnected
@testable import SimpleDocsOAuth

@MainActor private final class Anchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { ASPresentationAnchor() }
}

@MainActor private final class ScriptedAdapter: ConnectedFlowAdapter {
    enum Mode { case ok, unreachable, canceled, hang }
    var mode = Mode.ok
    var gate: CheckedContinuation<Void, Never>?
    func resourceMetadata(url: URL) async throws -> Data {
        if mode == .unreachable { throw URLError(.cannotConnectToHost) }
        if mode == .hang { await withCheckedContinuation { gate = $0 } }
        return Data(#"{"resource":"https://one.example.com","authorization_servers":["https://team.cloudflareaccess.com"]}"#.utf8)
    }
    func issuerMetadata(url: URL) async throws -> Data {
        try JSONSerialization.data(withJSONObject: ["issuer": "https://team.cloudflareaccess.com",
            "authorization_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/authorization",
            "token_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token",
            "registration_endpoint": "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/registration",
            "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"], "token_endpoint_auth_methods_supported": ["none"]])
    }
    func register(url: URL, metadata: PublicClientRegistration) async throws -> Data {
        try JSONSerialization.data(withJSONObject: ["client_id": "client-9", "redirect_uris": metadata.redirect_uris, "token_endpoint_auth_method": "none"])
    }
    func authorize(url: URL, callbackScheme: String) async throws -> URL {
        if mode == .canceled { throw ASWebAuthenticationSessionError(.canceledLogin) }
        let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
        var callback = URLComponents(string: ConnectedModel.callback.absoluteString)!
        callback.queryItems = [.init(name: "code", value: "code"), .init(name: "state", value: state)]
        return callback.url!
    }
    func exchange(_ request: TokenRequest, registry: InstanceRegistry) async throws -> OAuthTokens {
        try request.parse(data: Data(#"{"access_token":"acc-1","token_type":"Bearer","expires_in":900,"refresh_token":"ref-1","resource":"https://one.example.com/"}"#.utf8), registry: registry)
    }
    func send(plan: WorkerPlan, bearer: String) async throws -> Data { Data("{}".utf8) }
}

extension StubbedSuites { @MainActor @Suite struct ConnectedModelTests {
    private func make(_ adapter: ScriptedAdapter, vault: SessionVault = MemoryVault(), defaults: UserDefaults? = nil) -> (ConnectedModel, UserDefaults) {
        let defaults = defaults ?? UserDefaults(suiteName: "simpledocs.tests." + UUID().uuidString)!
        let model = ConnectedModel(vault: vault, defaults: defaults, anchor: Anchor(),
                                   adapterFactory: { _ in adapter }, apiProtocolClasses: [StubProtocol.self])
        model.instance = "https://one.example.com"
        model.issuer = "https://team.cloudflareaccess.com"
        return (model, defaults)
    }

    @Test func startsWithTheOwnersInstance() {
        let defaults = UserDefaults(suiteName: "simpledocs.tests." + UUID().uuidString)!
        let model = ConnectedModel(vault: MemoryVault(), defaults: defaults, anchor: Anchor())
        #expect(model.instance == "https://simpledocs.justinharbour.com")
        #expect(model.issuer == "https://justinharbour.cloudflareaccess.com")
        #expect(model.state == .signedOut)
    }

    @Test func signInStoresSessionInVaultAndRemembersInstance() async {
        let vault = MemoryVault()
        let (model, defaults) = make(ScriptedAdapter(), vault: vault)
        await model.signIn()
        #expect(model.state == .ready && model.api != nil && model.notice == nil)
        let stored = vault.load(instance: "https://one.example.com")
        #expect(stored?.accessToken == "acc-1" && stored?.clientID == "client-9" && stored?.tokens.tokens.refreshToken == "ref-1")
        #expect(defaults.string(forKey: ConnectedModel.instanceKey) == "https://one.example.com")
        #expect(defaults.string(forKey: ConnectedModel.issuerKey) == "https://team.cloudflareaccess.com")
        for (key, value) in defaults.dictionaryRepresentation() { #expect(!"\(value)".contains("acc-1"), "token leaked into \(key)") }
    }

    @Test func nextLaunchRestoresTheStoredSession() async {
        let vault = MemoryVault()
        let (first, defaults) = make(ScriptedAdapter(), vault: vault)
        await first.signIn()
        let relaunched = ConnectedModel(vault: vault, defaults: defaults, anchor: Anchor(), apiProtocolClasses: [StubProtocol.self])
        #expect(relaunched.instance == "https://one.example.com" && relaunched.state == .signedOut)
        relaunched.restore()
        #expect(relaunched.state == .ready && relaunched.api != nil)
    }

    @Test func restoreDoesNothingWithoutAStoredSession() {
        let (model, _) = make(ScriptedAdapter())
        model.restore()
        #expect(model.state == .signedOut && model.api == nil)
    }

    @Test func unreachableInstanceSaysSo() async {
        let adapter = ScriptedAdapter()
        adapter.mode = .unreachable
        let (model, _) = make(adapter)
        await model.signIn()
        #expect(model.state == .signedOut)
        #expect(model.notice == .unreachable(host: "one.example.com"))
        #expect(model.notice?.text.contains("one.example.com") == true)
    }

    @Test func cancelingTheBrowserIsNotAnError() async {
        let adapter = ScriptedAdapter()
        adapter.mode = .canceled
        let (model, _) = make(adapter)
        await model.signIn()
        #expect(model.state == .signedOut && model.notice == .canceled && model.notice?.isError == false)
    }

    @Test func badAddressesAreReportedBeforeAnyNetwork() async {
        let (model, _) = make(ScriptedAdapter())
        model.instance = "http://one.example.com"
        await model.signIn()
        #expect(model.notice == .problem(InstanceOriginError.schemeNotHTTPS.message))
        model.instance = "https://one.example.com"
        model.issuer = "https://example.com"
        await model.signIn()
        #expect(model.notice?.text.contains("Cloudflare Access address") == true)
        #expect(model.state == .signedOut)
    }

    @Test func signOutForgetsTheSessionButKeepsTheInstance() async {
        let vault = MemoryVault()
        let (model, defaults) = make(ScriptedAdapter(), vault: vault)
        await model.signIn()
        let before = model.sessionID
        model.signOut()
        #expect(model.state == .signedOut && model.api == nil && model.sessionID != before)
        #expect(vault.load(instance: "https://one.example.com") == nil)
        #expect(defaults.string(forKey: ConnectedModel.instanceKey) == "https://one.example.com")
    }

    @Test func refusedSessionPromptsForSignInAgain() async {
        let vault = MemoryVault()
        let (model, _) = make(ScriptedAdapter(), vault: vault)
        await model.signIn()
        StubProtocol.reset(["GET /api/records": [Stub(status: 401), Stub(status: 401)],
                            "POST /cdn-cgi/access/oauth/token": [Stub(status: 400)]])
        await #expect(throws: APIError.sessionExpired) { _ = try await model.call { try await $0.records() } }
        #expect(model.state == .expired && model.notice == .expired && model.api == nil)
        #expect(vault.load(instance: "https://one.example.com") == nil)
        #expect(model.instance == "https://one.example.com")
    }

    @Test func signOutWhileTheBrowserIsOpenDiscardsTheLateResult() async {
        let adapter = ScriptedAdapter()
        adapter.mode = .hang
        let (model, _) = make(adapter)
        let task = Task { await model.signIn() }
        while adapter.gate == nil { await Task.yield() }
        #expect(model.state == .signingIn)
        model.signOut()
        adapter.mode = .ok
        adapter.gate?.resume()
        adapter.gate = nil
        await task.value
        #expect(model.state == .signedOut && model.api == nil)
    }

    @Test func cancelDuringSignInReturnsToSignedOut() async {
        let adapter = ScriptedAdapter()
        adapter.mode = .hang
        let (model, _) = make(adapter)
        let task = Task { await model.signIn() }
        while adapter.gate == nil { await Task.yield() }
        model.cancelSignIn()
        adapter.gate?.resume()
        adapter.gate = nil
        await task.value
        #expect(model.state == .signedOut && model.notice == .canceled)
    }

    @Test func describesErrorsInPlainWords() {
        #expect(describe(APIError.unreachable).contains("Can't reach"))
        #expect(describe(APIError.server(status: 400, message: "Enter a sender name")) == "Enter a sender name")
        #expect(isNotFound(APIError.server(status: 404, message: "x")))
        #expect(!isNotFound(APIError.unreachable))
    }
}
}
