import Foundation

/// Whether a platform sign-in flow for self-deployed instances has been verified end to end.
/// Nothing is verified. The architecture blocks implementation and release until issuer and
/// audience binding, redirects, renewal and session handling are verified and reviewed.
/// There is intentionally no `verified` case in this package: adding one is a reviewed change.
public enum NativeAuthStatus: Sendable, Equatable {
    /// Not yet investigated or decided. Treated exactly like `unsupported`.
    case unknown
    /// Investigated and not available on the platform.
    case unsupported

    public static let current: NativeAuthStatus = .unknown
}

public enum CredentialDenial: Error, Equatable, Sendable {
    case noActiveInstance
    case staleContext
    case originMismatch
    case authenticationNotVerified

    public var message: String {
        switch self {
        case .noActiveInstance: "No instance is selected."
        case .staleContext: "The selected instance changed. Start the action again."
        case .originMismatch: "That address does not belong to the selected instance."
        case .authenticationNotVerified: "Sign-in to your instance is not available yet."
        }
    }
}

/// Decides whether a credential or session may be attached to a request. While native sign-in is
/// unverified the answer is always a denial, so this type has no "allowed" result.
///
/// Checks run from the cheapest structural failure to the auth gate, so a request aimed at the
/// wrong origin is reported as such even though it would be denied for auth anyway.
public enum CredentialPolicy {
    public static func evaluate(
        target: URL,
        pending: ContextBinding? = nil,
        registry: InstanceRegistry,
        auth: NativeAuthStatus = .current
    ) -> CredentialDenial {
        guard let context = registry.active else { return .noActiveInstance }
        if let pending, !registry.isCurrent(pending) { return .staleContext }
        guard OriginBinding.permits(target, for: context.scope.origin) else { return .originMismatch }
        switch auth {
        case .unknown, .unsupported:
            return .authenticationNotVerified
        }
    }

    /// Redirects are held to the same rule as requests; a credential never follows one to another origin.
    public static func evaluateRedirect(
        from source: URL,
        to destination: URL,
        registry: InstanceRegistry,
        auth: NativeAuthStatus = .current
    ) -> CredentialDenial {
        guard let context = registry.active else { return .noActiveInstance }
        guard OriginBinding.permits(source, for: context.scope.origin),
              OriginBinding.permits(destination, for: context.scope.origin)
        else { return .originMismatch }
        return evaluate(target: destination, registry: registry, auth: auth)
    }
}
