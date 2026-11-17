import CryptoKit
import Foundation

public enum OAuthFlowError: Error, Equatable {
    case staleContext, invalidConfiguration, invalidCallback, alreadyConsumed
}

/// An inert authorization-code transaction. Endpoints must be independently confirmed for the
/// chosen instance; discovery alone does not establish trust. No request or token exchange occurs.
@MainActor public final class ManagedOAuthTransaction {
    private let binding: ContextBinding
    private let callback: URL
    private let state: String
    private let verifier: String
    private let clientID: String
    private let resource: String
    private let tokenEndpoint: URL
    private var consumed = false
    public let authorizationURL: URL

    /// The caller supplies exact endpoints after independently establishing trust. This constructor
    /// does not establish trust and must not be used as permission to send credentials.
    public init(registry: InstanceRegistry, binding: ContextBinding, authorizationEndpoint: URL,
                tokenEndpoint: URL, callback: URL, clientID: String) throws {
        guard let active = registry.active, registry.isCurrent(binding) else { throw OAuthFlowError.staleContext }
        func validEndpoint(_ url: URL) -> Bool {
            guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
            return c.scheme == "https" && c.host != nil && c.user == nil && c.password == nil && c.query == nil && c.fragment == nil
        }
        guard validEndpoint(authorizationEndpoint), validEndpoint(tokenEndpoint),
              let redirect = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              let scheme = redirect.scheme, scheme.contains("."), scheme != "https", scheme != "http",
              redirect.user == nil, redirect.password == nil, redirect.query == nil, redirect.fragment == nil,
              !redirect.path.isEmpty, !clientID.isEmpty, clientID.utf8.count <= 1024
        else { throw OAuthFlowError.invalidConfiguration }
        func randomString() -> String {
            var generator = SystemRandomNumberGenerator()
            return Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
                .base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let verifier = randomString()
        let state = randomString()
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let resource = active.scope.origin.canonical + "/"
        var components = URLComponents(url: authorizationEndpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: callback.absoluteString), URLQueryItem(name: "resource", value: resource),
            URLQueryItem(name: "state", value: state), URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256")
        ]
        guard let authorizationURL = components.url else { throw OAuthFlowError.invalidConfiguration }
        self.binding = binding; self.callback = callback; self.state = state; self.verifier = verifier
        self.clientID = clientID; self.resource = resource; self.tokenEndpoint = tokenEndpoint
        self.authorizationURL = authorizationURL
    }

    /// Consumes the transaction even on invalid callback to prevent replay. Exchange details contain
    /// secrets; do not log, persist, or transmit until endpoint trust and transport are verified.
    public func consume(callbackURL: URL, registry: InstanceRegistry) throws -> OAuthCodeExchange {
        guard !consumed else { throw OAuthFlowError.alreadyConsumed }
        consumed = true
        guard registry.isCurrent(binding) else { throw OAuthFlowError.staleContext }
        guard var received = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let expected = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              received.fragment == nil else { throw OAuthFlowError.invalidCallback }
        let items = received.queryItems ?? []
        received.query = nil
        guard received == expected, items.count == 2,
              items.filter({ $0.name == "state" }).count == 1,
              items.filter({ $0.name == "code" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state,
              let code = items.first(where: { $0.name == "code" })?.value,
              !code.isEmpty, code.utf8.count <= 4096
        else { throw OAuthFlowError.invalidCallback }
        return OAuthCodeExchange(endpoint: tokenEndpoint, code: code, verifier: verifier,
                                 clientID: clientID, redirectURI: callback.absoluteString,
                                 resource: resource, binding: binding)
    }
}

/// Sensitive single-use exchange material; not an authenticated session.
public struct OAuthCodeExchange {
    public let endpoint: URL
    public let code: String
    public let verifier: String
    public let clientID: String
    public let redirectURI: String
    public let resource: String
    public let binding: ContextBinding
}
