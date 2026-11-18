import AuthenticationServices
import Foundation
import Observation
import SimpleDocsConnected

/// Sign-in state for the apps: which instance, whether a session exists, and why sign-in stopped.
/// Tokens stay in the Keychain through `SessionVault`; only the instance and team addresses are remembered
/// in UserDefaults so the next launch can pick up where it left off.
@MainActor @Observable public final class ConnectedModel {
    public enum State: Equatable, Sendable { case signedOut, signingIn, ready, expired }

    public enum Notice: Equatable, Sendable {
        case canceled
        case unreachable(host: String)
        case expired
        case problem(String)

        public var text: String {
            switch self {
            case .canceled: "Sign-in was canceled."
            case .unreachable(let host): "Can't reach \(host). Check your connection and the address, then try again."
            case .expired: "Your session ended. Sign in again to keep going."
            case .problem(let text): text
            }
        }
        public var isError: Bool { self != .canceled }
    }

    public static let defaultInstance = "https://simpledocs.justinharbour.dev"
    public static let defaultIssuer = "https://justinharbour.cloudflareaccess.com"
    public static let callback = URL(string: "dev.justinharbour.simpledocs:/oauth/callback")!
    static let instanceKey = "simpledocs.lastInstance"
    static let issuerKey = "simpledocs.accessTeam"

    public var instance: String
    public var issuer: String
    public private(set) var state: State = .signedOut
    public private(set) var notice: Notice?
    public private(set) var api: WorkerAPI?
    /// Bumps on sign-in, sign-out and expiry so screens can drop what they loaded for the old session.
    public private(set) var sessionID = UUID()

    private let vault: SessionVault
    private let defaults: UserDefaults
    private let anchor: ASWebAuthenticationPresentationContextProviding
    private let adapterFactory: (@MainActor (OAuthBrowser) -> any ConnectedFlowAdapter)?
    private let apiProtocolClasses: [AnyClass]?
    private var attempt: (id: UUID, session: AppSession, browser: OAuthBrowser)?

    public init(vault: SessionVault = KeychainVault(), defaults: UserDefaults = .standard,
                anchor: ASWebAuthenticationPresentationContextProviding,
                adapterFactory: (@MainActor (OAuthBrowser) -> any ConnectedFlowAdapter)? = nil,
                apiProtocolClasses: [AnyClass]? = nil) {
        self.vault = vault
        self.defaults = defaults
        self.anchor = anchor
        self.adapterFactory = adapterFactory
        self.apiProtocolClasses = apiProtocolClasses
        instance = defaults.string(forKey: Self.instanceKey) ?? Self.defaultInstance
        issuer = defaults.string(forKey: Self.issuerKey) ?? Self.defaultIssuer
    }

    public var instanceHost: String { (try? InstanceOrigin.parse(instance).get())?.host ?? instance }

    /// Picks up a stored session for the last instance. Call once at launch.
    public func restore() {
        guard state == .signedOut, let stored = vault.load(instance: canonicalInstance ?? instance) else { return }
        guard let client = try? WorkerAPI(session: stored, vault: vault, protocolClasses: apiProtocolClasses) else { return }
        api = client
        issuer = stored.issuer
        state = .ready
    }

    private var canonicalInstance: String? { (try? InstanceOrigin.parse(instance).get())?.canonical }

    public func signIn() async {
        guard state != .signingIn else { return }
        notice = nil
        let origin: InstanceOrigin
        switch InstanceOrigin.parse(instance) {
        case .success(let value): origin = value
        case .failure(let error): notice = .problem(error.message); return
        }
        let id = UUID()
        var started = false
        do {
            var registry = InstanceRegistry()
            let linked = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
            let binding = ContextBinding(try registry.activate(linked.linkID))
            let owner = SessionCoordinator(registry: registry)
            let preparation: SignInPreparation
            do { preparation = try SignInPreparation(registry: registry, binding: binding, configuredIssuer: issuer) }
            catch { notice = .problem("Check the Cloudflare Access address. It looks like https://your-team.cloudflareaccess.com."); return }
            // Starting the sign-in is the confirmation: the screen shows both addresses beside the button.
            let confirmation = try preparation.confirm(resource: preparation.resource, issuer: preparation.issuer, registry: owner.registry)
            let browser = OAuthBrowser(anchorProvider: anchor)
            let adapter = adapterFactory?(browser) ?? ConnectedHTTP(browser: browser)
            let flow = ConnectedFlow(owner: owner, adapter: adapter)
            let session = AppSession(flow: flow)
            cancelAttempt()
            attempt = (id, session, browser)
            started = true
            state = .signingIn
            try await session.signIn(confirmation: confirmation, binding: binding, callback: Self.callback)
            guard attempt?.id == id else { return }
            guard let grant = flow.grant else { throw ConnectedFlowError.noSession }
            flow.clear()
            let stored = StoredSession(instance: origin.canonical, issuer: grant.issuer, clientID: grant.clientID,
                                       tokenEndpoint: grant.tokenEndpoint, tokens: grant.tokens)
            try vault.save(stored)
            api = try WorkerAPI(session: stored, vault: vault, protocolClasses: apiProtocolClasses)
            instance = origin.canonical
            issuer = grant.issuer
            defaults.set(instance, forKey: Self.instanceKey)
            defaults.set(issuer, forKey: Self.issuerKey)
            attempt = nil
            sessionID = UUID()
            state = .ready
        } catch {
            // A sign-out or cancel while the browser was open already settled the state.
            if started { guard attempt?.id == id else { return } }
            attempt = nil
            api = nil
            state = .signedOut
            notice = Self.notice(for: error, host: origin.host)
        }
    }

    /// Stops a sign-in that is waiting on the browser sheet.
    public func cancelSignIn() {
        guard state == .signingIn else { return }
        cancelAttempt()
        state = .signedOut
        notice = .canceled
    }

    private func cancelAttempt() {
        attempt?.session.signOut()
        attempt?.browser.cancel()
        attempt = nil
    }

    /// Clears this device only. It does not revoke the token at Cloudflare.
    public func signOut() {
        cancelAttempt()
        if let key = canonicalInstance { vault.delete(instance: key) }
        endSession(.signedOut, notice: nil)
    }

    /// The token was refused and could not be renewed.
    public func expire() {
        guard state == .ready else { return }
        if let key = canonicalInstance { vault.delete(instance: key) }
        endSession(.expired, notice: .expired)
    }

    private func endSession(_ next: State, notice: Notice?) {
        api = nil
        WorkerAPI.clearDownloads()
        sessionID = UUID()
        state = next
        self.notice = notice
    }

    /// Runs one API call and turns a refused session into the re-sign-in prompt.
    public func call<T: Sendable>(_ operation: @Sendable (WorkerAPI) async throws -> T) async throws -> T {
        guard let api else { throw APIError.sessionExpired }
        do { return try await operation(api) }
        catch APIError.sessionExpired { expire(); throw APIError.sessionExpired }
    }

    static func notice(for error: Error, host: String) -> Notice {
        switch error {
        case is CancellationError: return .canceled
        case let error as ASWebAuthenticationSessionError where error.code == .canceledLogin: return .canceled
        case is URLError: return .unreachable(host: host)
        case DiscoveryError.oauthNotAdvertised:
            return .problem("This instance doesn't have Cloudflare Access app sign-in turned on. Turn on Managed OAuth for the app, then try again.")
        case ConnectedFlowError.invalidResponse, DiscoveryError.invalidMetadata, DiscoveryError.invalidResponse:
            return .problem("\(host) didn't answer like a simpledocs instance with app sign-in. Check the address and the Cloudflare Access team.")
        case is ExchangeError, is OAuthFlowError:
            return .problem("Cloudflare signed you in, but the app couldn't use the result. Try again.")
        default: return .problem("Sign-in didn't finish. Try again.")
        }
    }
}

public enum Phase: Equatable, Sendable {
    case idle, loading, loaded
    case failed(String)
    public var isLoading: Bool { self == .loading }
    public var error: String? { if case .failed(let text) = self { text } else { nil } }
}

public func describe(_ error: Error) -> String {
    switch error {
    case let error as APIError: error.message
    case is DecodingError: APIError.invalidResponse.message
    default: "Something went wrong. Try again."
    }
}

public func isNotFound(_ error: Error) -> Bool {
    if case APIError.server(let status, _) = error { return status == 404 }
    return false
}
