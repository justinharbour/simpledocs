import Foundation
import SimpleDocsConnected

public enum DiscoveryError: Error, Equatable {
    case staleContext, invalidResponse, responseTooLarge, invalidMetadata, oauthNotAdvertised
}

/// Discovery is restricted to the chosen instance and does not send credentials. This conservative
/// profile accepts only an issuer equal to the instance origin and same-origin OAuth endpoints.
/// Some valid Cloudflare deployments may use a different issuer and must remain unavailable until
/// an independently configured issuer trust mechanism is added.
public struct OAuthMetadata: Sendable, Equatable {
    public let issuer: String
    public let authorizationEndpoint: URL
    public let tokenEndpoint: URL
    public let binding: ContextBinding

    public static func validate(data: Data, registry: InstanceRegistry, binding: ContextBinding) throws -> OAuthMetadata {
        guard registry.isCurrent(binding), let active = registry.active else { throw DiscoveryError.staleContext }
        guard data.count <= 65_536 else { throw DiscoveryError.responseTooLarge }
        struct Document: Decodable {
            let issuer: String
            let authorization_endpoint: String
            let token_endpoint: String
            let response_types_supported: [String]
            let code_challenge_methods_supported: [String]
            let token_endpoint_auth_methods_supported: [String]
        }
        guard let document = try? JSONDecoder().decode(Document.self, from: data),
              document.issuer == active.scope.origin.canonical,
              document.response_types_supported.contains("code"),
              document.code_challenge_methods_supported.contains("S256"),
              document.token_endpoint_auth_methods_supported.contains("none"),
              let authorization = URL(string: document.authorization_endpoint),
              let token = URL(string: document.token_endpoint),
              endpointAllowed(authorization, origin: active.scope.origin),
              endpointAllowed(token, origin: active.scope.origin)
        else { throw DiscoveryError.invalidMetadata }
        return OAuthMetadata(issuer: document.issuer, authorizationEndpoint: authorization,
                             tokenEndpoint: token, binding: binding)
    }

    private static func endpointAllowed(_ url: URL, origin: InstanceOrigin) -> Bool {
        guard OriginBinding.permits(url, for: origin),
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.query == nil, c.fragment == nil, !c.path.isEmpty else { return false }
        return true
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public enum OAuthDiscovery {
    /// Uses platform TLS verification. Redirects, caches, shared cookies and URL credentials are disabled.
    /// The caller must recheck the live registry after this asynchronous operation before using its result.
    public static func fetch(registry: InstanceRegistry, binding: ContextBinding) async throws -> OAuthMetadata {
        guard registry.isCurrent(binding), let active = registry.active else { throw DiscoveryError.staleContext }
        var components = URLComponents(url: active.scope.origin.url, resolvingAgainstBaseURL: false)!
        components.path = "/.well-known/oauth-authorization-server"
        guard let url = components.url else { throw DiscoveryError.invalidMetadata }
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.url == url,
              http.mimeType?.lowercased() == "application/json" else { throw DiscoveryError.invalidResponse }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 65_536 else { throw DiscoveryError.responseTooLarge }
            data.append(byte)
        }
        return try OAuthMetadata.validate(data: data, registry: registry, binding: binding)
    }
}
