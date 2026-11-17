import Foundation
import SimpleDocsConnected

public enum ConnectedFlowError: Error { case invalidResponse, noSession, invalidToken }

/// Implementations must use TLS, refuse redirects and bound response sizes. Mock implementations
/// are for tests only. Credentials and bodies must never be logged.
@MainActor public protocol ConnectedFlowAdapter {
    func resourceMetadata(url: URL) async throws -> Data
    func issuerMetadata(url: URL) async throws -> Data
    func register(url: URL, metadata: PublicClientRegistration) async throws -> Data
    func authorize(url: URL, callbackScheme: String) async throws -> URL
    func exchange(_ request: TokenRequest, registry: InstanceRegistry) async throws -> OAuthTokens
    func send(plan: WorkerPlan, bearer: String) async throws -> Data
}

/// Experimental in-memory orchestration. It is not wired to any application target.
@MainActor public final class ConnectedFlow {
    private let owner: SessionCoordinator
    private let adapter: any ConnectedFlowAdapter
    private var session: (binding: ContextBinding, tokens: ExpiringTokens)?

    public init(owner: SessionCoordinator, adapter: any ConnectedFlowAdapter) {
        self.owner = owner
        self.adapter = adapter
    }

    public func signIn(confirmation: IssuerConfirmation, binding: ContextBinding, callback: URL,
                       now: @escaping @MainActor () -> Date = Date.init) async throws {
        owner.cancel()
        session = nil
        guard confirmation.binding == binding, let active = owner.registry.active, owner.registry.isCurrent(binding),
              active.scope.origin.canonical == confirmation.resource else { throw CoordinatorError.staleContext }
        let trust = try CloudflareTrust(registry: owner.registry, binding: binding, configuredTeam: confirmation.issuer)
        let resourceURL = URL(string: trust.resource.canonical + "/.well-known/cloudflare-access-protected-resource/")!
        let issuerURL = URL(string: trust.team.canonical + "/.well-known/oauth-authorization-server")!
        let resource = try await owner.run(binding: binding) { try await self.adapter.resourceMetadata(url: resourceURL) }
        try trust.validateResourceMetadata(resource, registry: owner.registry)
        let issuer = try await owner.run(binding: binding) { try await self.adapter.issuerMetadata(url: issuerURL) }
        let endpoints = try trust.validateIssuerMetadata(issuer, registry: owner.registry)
        let registration = try PublicClientRegistration(name: "Simpledocs", callback: callback, resource: active.scope.origin)
        let data = try await owner.run(binding: binding) { try await self.adapter.register(url: endpoints.registration, metadata: registration) }
        struct Registered: Decodable {
            let client_id: String
            let redirect_uris: [String]
            let token_endpoint_auth_method: String
            let client_secret: String?
        }
        guard data.count <= 65_536, let registered = try? JSONDecoder().decode(Registered.self, from: data),
              !registered.client_id.isEmpty, registered.client_id.utf8.count <= 1024,
              registered.redirect_uris == [callback.absoluteString], registered.token_endpoint_auth_method == "none",
              registered.client_secret == nil, let scheme = callback.scheme else { throw ConnectedFlowError.invalidResponse }
        let transaction = try ManagedOAuthTransaction(registry: owner.registry, binding: binding,
            authorizationEndpoint: endpoints.authorization, tokenEndpoint: endpoints.token, callback: callback, clientID: registered.client_id)
        let result = try await owner.run(binding: binding) { try await self.adapter.authorize(url: transaction.authorizationURL, callbackScheme: scheme) }
        let exchange = try transaction.consume(callbackURL: result, registry: owner.registry)
        let request = try TokenRequest(exchange: exchange, endpoints: endpoints, registry: owner.registry)
        let snapshot = owner.registry
        let exchangeStarted = now()
        let tokens = try await owner.run(binding: binding) { try await self.adapter.exchange(request, registry: snapshot) }
        guard owner.registry.isCurrent(binding), tokens.resource == active.scope.origin.canonical + "/" else { throw CoordinatorError.staleContext }
        session = (binding, try ExpiringTokens(tokens: tokens, receivedAt: exchangeStarted))
    }

    public func perform(_ operation: WorkerOperation, now: Date = Date()) async throws -> Data {
        guard let session, owner.registry.isCurrent(session.binding) else { self.session = nil; throw ConnectedFlowError.noSession }
        let tokens: OAuthTokens
        do { tokens = try session.tokens.valid(at: now) } catch { self.session = nil; throw error }
        // Prevent header injection and reject non-ASCII control/whitespace.
        guard !tokens.accessToken.isEmpty, tokens.accessToken.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7e }) else {
            self.session = nil; throw ConnectedFlowError.invalidToken
        }
        let plan = try WorkerPlanner.plan(operation, binding: session.binding, registry: owner.registry)
        return try await owner.run(binding: session.binding) { try await self.adapter.send(plan: plan, bearer: tokens.accessToken) }
    }

    public func clear() { owner.cancel(); session = nil }
}
