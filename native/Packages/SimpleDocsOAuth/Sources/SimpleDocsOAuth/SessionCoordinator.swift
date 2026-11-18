import Foundation
import SimpleDocsConnected

public enum CoordinatorError: Error, Equatable {
    case staleContext, confirmationRequired, expired, invalidLifetime
}

/// Confirmation is deliberately explicit; it does not establish the provenance of the issuer.
public struct IssuerConfirmation: Sendable {
    public let resource: String
    public let issuer: String
    public let binding: ContextBinding

    public init(registry: InstanceRegistry, binding: ContextBinding, configuredIssuer: String,
                confirmedResource: String, confirmedIssuer: String) throws {
        let trust = try CloudflareTrust(registry: registry, binding: binding, configuredTeam: configuredIssuer)
        guard confirmedResource == trust.resource.canonical, confirmedIssuer == trust.team.canonical else {
            throw CoordinatorError.confirmationRequired
        }
        resource = confirmedResource
        issuer = confirmedIssuer
        self.binding = binding
    }
}

/// Public-client registration metadata; it contains no client secret.
public struct PublicClientRegistration: Encodable, Sendable {
    public let client_name: String
    public let redirect_uris: [String]
    public let resource: String
    public let grant_types = ["authorization_code", "refresh_token"]
    public let response_types = ["code"]
    public let token_endpoint_auth_method = "none"

    public init(name: String, callback: URL, resource: InstanceOrigin) throws {
        guard !name.isEmpty, name.utf8.count <= 128,
              let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              let scheme = parts.scheme, scheme.contains("."), scheme != "http", scheme != "https",
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              !parts.path.isEmpty else { throw OAuthFlowError.invalidConfiguration }
        client_name = name
        redirect_uris = [callback.absoluteString]
        self.resource = resource.canonical
    }
}

/// The owner must not expose mutable copies of its registry to application code.
/// Adapters are deliberately injected: no live networking is enabled by this coordinator.
@MainActor public final class SessionCoordinator {
    public private(set) var registry: InstanceRegistry
    private var cancelPending: (() -> Void)?
    private var generation: UInt64 = 0

    public init(registry: InstanceRegistry) { self.registry = registry }

    public func activate(_ id: InstanceLinkID) throws {
        guard registry.instances[id] != nil else { throw LinkError.notLinked }
        if registry.activeLinkID != id { invalidate() }
        try registry.activate(id)
    }

    /// Purge must succeed before the link is removed. Server revocation is not implied.
    @discardableResult public func unlink(_ id: InstanceLinkID, purge: (SessionScope) throws -> Void) throws -> UnlinkReceipt {
        guard let instance = registry.instances[id] else { throw LinkError.notLinked }
        invalidate()
        try purge(instance.scope)
        return try registry.unlink(id)
    }

    public func cancel() { invalidate() }

    private func invalidate() {
        generation &+= 1
        cancelPending?()
        cancelPending = nil
    }

    /// Runs one asynchronous stage. Results from adapters that ignore cancellation are discarded.
    public func run<Value: Sendable>(binding: ContextBinding,
                                    operation: @escaping @MainActor () async throws -> Value) async throws -> Value {
        guard registry.isCurrent(binding) else { throw CoordinatorError.staleContext }
        let captured = generation
        let task = Task { @MainActor in try await operation() }
        cancelPending?()
        // Starting another stage invalidates the earlier one even if its adapter ignores cancellation.
        generation &+= 1
        let current = generation
        cancelPending = { task.cancel() }
        defer { if generation == current { cancelPending = nil } }
        return try await withTaskCancellationHandler {
            let value = try await task.value
            guard captured &+ 1 == current, generation == current, registry.isCurrent(binding), !Task.isCancelled else {
                throw CoordinatorError.staleContext
            }
            return value
        } onCancel: { task.cancel() }
    }
}

/// Persist an absolute expiration, never just the server's relative interval.
public struct ExpiringTokens: Codable, Sendable {
    public let tokens: OAuthTokens
    public let expiresAt: Date

    public init(tokens: OAuthTokens, receivedAt: Date) throws {
        guard tokens.expiresIn > 0, tokens.expiresIn <= 31_536_000 else { throw CoordinatorError.invalidLifetime }
        self.tokens = tokens
        self.expiresAt = receivedAt.addingTimeInterval(TimeInterval(tokens.expiresIn))
    }

    public func valid(at now: Date) throws -> OAuthTokens {
        guard now < expiresAt else { throw CoordinatorError.expired }
        return tokens
    }
}
