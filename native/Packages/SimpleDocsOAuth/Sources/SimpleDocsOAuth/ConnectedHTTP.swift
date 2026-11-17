import Foundation
import SimpleDocsConnected

private final class NoHTTPRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Ephemeral transport for the experimental coordinator; response contents are never logged.
@MainActor public final class ConnectedHTTP: ConnectedFlowAdapter {
    private let browser: OAuthBrowser
    public init(browser: OAuthBrowser) { self.browser = browser }

    private func request(_ request: URLRequest, maximum: Int) async throws -> Data {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 15
        let session = URLSession(configuration: config, delegate: NoHTTPRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              http.url == request.url, http.mimeType?.lowercased() == "application/json" else { throw ConnectedFlowError.invalidResponse }
        var data = Data()
        for try await byte in bytes {
            guard data.count < maximum else { throw ConnectedFlowError.invalidResponse }
            data.append(byte)
        }
        return data
    }

    public func resourceMetadata(url: URL) async throws -> Data { try await metadata(url) }
    public func issuerMetadata(url: URL) async throws -> Data { try await metadata(url) }
    private func metadata(_ url: URL) async throws -> Data {
        var req = URLRequest(url: url); req.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await request(req, maximum: 65_536)
    }
    public func register(url: URL, metadata: PublicClientRegistration) async throws -> Data {
        var req = URLRequest(url: url); req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONEncoder().encode(metadata)
        return try await request(req, maximum: 65_536)
    }
    public func authorize(url: URL, callbackScheme: String) async throws -> URL {
        try await browser.authorize(url: url, callbackScheme: callbackScheme)
    }
    public func exchange(_ request: TokenRequest, registry: InstanceRegistry) async throws -> OAuthTokens {
        try await TokenTransport.exchange(request, registry: registry)
    }
    public func send(plan: WorkerPlan, bearer: String) async throws -> Data {
        var req = URLRequest(url: plan.url); req.httpMethod = plan.method; req.httpBody = plan.body
        req.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let type = plan.contentType { req.setValue(type, forHTTPHeaderField: "Content-Type") }
        return try await request(req, maximum: 1_048_576)
    }
}
