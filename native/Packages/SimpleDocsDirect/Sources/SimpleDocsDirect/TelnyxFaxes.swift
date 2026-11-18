import Foundation

public struct DirectFax: Decodable, Identifiable, Sendable {
    public let id: String
    public let status: String?
    public let direction: String?
    public let from: String?
    public let to: String?
    public let created_at: String?
}

public enum DirectFaxError: Error, Equatable {
    case invalidKey, unauthorized, unavailable, invalidResponse
}

/// An ephemeral session, with redirects refused to prevent forwarding a bearer key.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public struct TelnyxFaxes {
    private let transport: (URLRequest) async throws -> (Data, URLResponse)

    public init() {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        let session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
        transport = { try await session.data(for: $0) }
    }

    init(transport: @escaping (URLRequest) async throws -> (Data, URLResponse)) {
        self.transport = transport
    }

    /// Fetches the first page only. Never sends communications or follows provider URLs.
    public func list(key: String) async throws -> [DirectFax] {
        guard !key.isEmpty, key.utf8.count <= 4096,
              key.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }) else {
            throw DirectFaxError.invalidKey
        }
        var request = URLRequest(url: URL(string: "https://api.telnyx.com/v2/faxes?page%5Bsize%5D=25&page%5Bnumber%5D=1")!)
        request.httpMethod = "GET"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 20
        let data: Data
        let response: URLResponse
        do { (data, response) = try await transport(request) }
        catch { throw DirectFaxError.unavailable }
        guard let http = response as? HTTPURLResponse else { throw DirectFaxError.invalidResponse }
        if http.statusCode == 401 || http.statusCode == 403 { throw DirectFaxError.unauthorized }
        guard http.statusCode == 200 else { throw DirectFaxError.unavailable }
        guard data.count <= 2_000_000,
              let result = try? JSONDecoder().decode(Response.self, from: data) else { throw DirectFaxError.invalidResponse }
        return result.data
    }

    private struct Response: Decodable { let data: [DirectFax] }
}
