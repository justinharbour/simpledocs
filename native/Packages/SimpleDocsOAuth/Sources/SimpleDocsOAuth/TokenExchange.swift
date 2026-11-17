import Foundation
import SimpleDocsConnected

public enum ExchangeError: Error, Equatable { case staleContext, invalidEndpoint, invalidResponse, tooLarge }

public struct OAuthTokens: Codable, Sendable {
    public let accessToken: String
    public let refreshToken: String?
    public let expiresIn: Int
    public let resource: String
}

/// Constructed only from a validated endpoint set and a transaction for the same live link.
public struct TokenRequest: Sendable {
    public let url: URL
    public let body: Data
    public let binding: ContextBinding
    public let resource: String

    public init(exchange: OAuthCodeExchange, endpoints: CloudflareEndpoints, registry: InstanceRegistry) throws {
        guard registry.isCurrent(exchange.binding), endpoints.binding == exchange.binding else { throw ExchangeError.staleContext }
        guard exchange.endpoint == endpoints.token, let active = registry.active,
              exchange.resource == active.scope.origin.canonical + "/" else { throw ExchangeError.invalidEndpoint }
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "grant_type", value: "authorization_code"),
                           URLQueryItem(name: "code", value: exchange.code),
                           URLQueryItem(name: "client_id", value: exchange.clientID),
                           URLQueryItem(name: "redirect_uri", value: exchange.redirectURI),
                           URLQueryItem(name: "code_verifier", value: exchange.verifier),
                           URLQueryItem(name: "resource", value: exchange.resource)]
        // URL query encoding leaves '+' unescaped; in form encoding it means a space.
        guard let encoded = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B"),
              let body = encoded.data(using: .utf8) else { throw ExchangeError.invalidEndpoint }
        self.url = endpoints.token; self.body = body; self.binding = exchange.binding; self.resource = exchange.resource
    }

    public func parse(data: Data, registry: InstanceRegistry) throws -> OAuthTokens {
        guard registry.isCurrent(binding) else { throw ExchangeError.staleContext }
        guard data.count <= 65_536 else { throw ExchangeError.tooLarge }
        struct Response: Decodable { let access_token: String; let token_type: String; let expires_in: Int; let refresh_token: String?; let resource: String }
        guard let response = try? JSONDecoder().decode(Response.self, from: data),
              !response.access_token.isEmpty, response.access_token.utf8.count <= 16_384,
              response.refresh_token.map({ !$0.isEmpty && $0.utf8.count <= 16_384 }) ?? true,
              response.token_type.lowercased() == "bearer", response.expires_in > 0,
              response.resource == resource else { throw ExchangeError.invalidResponse }
        return OAuthTokens(accessToken: response.access_token, refreshToken: response.refresh_token,
                           expiresIn: response.expires_in, resource: resource)
    }
}

private final class RejectRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

public enum TokenTransport {
    /// Caller must recheck the live registry after awaiting; this function receives a snapshot.
    public static func exchange(_ plan: TokenRequest, registry: InstanceRegistry) async throws -> OAuthTokens {
        guard registry.isCurrent(plan.binding) else { throw ExchangeError.staleContext }
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil; config.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: config, delegate: RejectRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: plan.url)
        request.httpMethod = "POST"; request.httpBody = plan.body
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.url == plan.url,
              http.mimeType?.lowercased() == "application/json" else { throw ExchangeError.invalidResponse }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 65_536 else { throw ExchangeError.tooLarge }
            data.append(byte)
        }
        return try plan.parse(data: data, registry: registry)
    }
}
