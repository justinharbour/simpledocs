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
    case rejected(Int), outcomeUnknown
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

    /// Submits exactly one reviewed PDF. Never retries: a lost response may still mean a fax was queued.
    public func send(key: String, connection: String, from: String, to: String, pdf: Data) async throws -> DirectFax {
        guard !key.isEmpty, key.utf8.count <= 4096, key.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }) else { throw DirectFaxError.invalidKey }
        guard !connection.isEmpty, connection.utf8.count <= 128,
              connection.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || $0 == 45 || $0 == 95 }),
              Self.phone(from), Self.phone(to), !pdf.isEmpty, pdf.count <= 20 * 1024 * 1024, pdf.starts(with: Data("%PDF-".utf8)) else { throw DirectFaxError.invalidResponse }
        let boundary = "simpledocs-\(UUID().uuidString)"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        field("connection_id", connection); field("from", from); field("to", to)
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"contents\"; filename=\"document.pdf\"\r\nContent-Type: application/pdf\r\n\r\n".utf8))
        body.append(pdf)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = URLRequest(url: URL(string: "https://api.telnyx.com/v2/faxes")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = body; request.timeoutInterval = 60
        let data: Data, response: URLResponse
        do { (data, response) = try await transport(request) } catch { throw DirectFaxError.outcomeUnknown }
        guard let http = response as? HTTPURLResponse else { throw DirectFaxError.outcomeUnknown }
        if http.statusCode == 401 || http.statusCode == 403 { throw DirectFaxError.unauthorized }
        guard http.statusCode == 202 else {
            if (400..<500).contains(http.statusCode), http.statusCode != 408 { throw DirectFaxError.rejected(http.statusCode) }
            throw DirectFaxError.outcomeUnknown
        }
        struct Created: Decodable { let data: DirectFax }
        guard data.count <= 2_000_000, let result = try? JSONDecoder().decode(Created.self, from: data) else { throw DirectFaxError.outcomeUnknown }
        return result.data
    }

    private static func phone(_ value: String) -> Bool {
        value.first == "+" && (2...16).contains(value.count) && value.dropFirst().utf8.allSatisfy { $0 >= 48 && $0 <= 57 } && value.dropFirst().first != "0"
    }
}
