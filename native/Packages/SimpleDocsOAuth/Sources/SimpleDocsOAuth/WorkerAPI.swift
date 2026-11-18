import Foundation
import SimpleDocsConnected

public enum APIError: Error, Equatable, Sendable {
    /// The instance could not be reached (offline, DNS, TLS, timeout).
    case unreachable
    /// The token was refused and could not be renewed. The person has to sign in again.
    case sessionExpired
    /// The Worker answered with an error. `message` is the Worker's own `error` text when it sent one.
    case server(status: Int, message: String)
    case invalidResponse

    public var message: String {
        switch self {
        case .unreachable: "Can't reach your instance. Check your connection and the address."
        case .sessionExpired: "Your session ended. Sign in again to continue."
        case .server(_, let message): message
        case .invalidResponse: "Your instance sent a response the app doesn't understand."
        }
    }
}

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Typed client for the owner Worker. It sends `Authorization: Bearer` (Cloudflare Access resolves the
/// opaque token to its own assertion) and the instance `Origin`, which the Worker requires on writes.
/// It never follows a redirect, renews an expiring token once, and never logs tokens or bodies.
public actor WorkerAPI {
    public private(set) var session: StoredSession
    private let origin: InstanceOrigin
    private let vault: SessionVault
    private let urlSession: URLSession
    private let now: @Sendable () -> Date
    private var refreshing: Task<StoredSession, Error>?
    private static let jsonLimit = 8 * 1024 * 1024

    public init(session: StoredSession, vault: SessionVault, protocolClasses: [AnyClass]? = nil,
                now: @escaping @Sendable () -> Date = Date.init) throws {
        guard let origin = try? InstanceOrigin.parse(session.instance).get() else { throw APIError.invalidResponse }
        self.session = session
        self.origin = origin
        self.vault = vault
        self.now = now
        let config = URLSessionConfiguration.ephemeral
        if let protocolClasses { config.protocolClasses = protocolClasses }
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        self.urlSession = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }

    deinit { urlSession.invalidateAndCancel() }

    // MARK: Records and sending

    public func records() async throws -> [RecordItem] {
        try await get("/api/records", as: RecordsResponse.self).records
    }

    public func transmission(id: String) async throws -> TransmissionDetail {
        try await get("/api/transmissions/\(id)", as: TransmissionDetail.self)
    }

    public func createTransmission(pdf: Data, filename: String, spec: Data) async throws -> CreatedTransmission {
        try await createTransmission(documents: [(data: pdf, name: filename)], spec: spec)
    }

    public func createTransmission(documents: [(data: Data, name: String)], spec: Data) async throws -> CreatedTransmission {
        let boundary = "simpledocs-" + UUID().uuidString
        var body = Data()
        func add(_ text: String) { body.append(Data(text.utf8)) }
        // Older Workers must reject a multi-document request, not send a subset.
        let field = documents.count == 1 ? "document" : "documents"
        for document in documents {
            let safeName = document.name.filter { $0 != "\"" && $0 != "\\" && !$0.isNewline && ($0.asciiValue.map { $0 >= 32 && $0 < 127 } ?? true) }
            add("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field)\"; filename=\"\(safeName.isEmpty ? "document.pdf" : safeName)\"\r\nContent-Type: application/pdf\r\n\r\n")
            body.append(document.data)
            add("\r\n")
        }
        add("--\(boundary)\r\nContent-Disposition: form-data; name=\"spec\"\r\nContent-Type: application/json\r\n\r\n")
        body.append(spec)
        add("\r\n--\(boundary)--\r\n")
        let data = try await send("POST", "/api/transmissions", body: body, contentType: "multipart/form-data; boundary=\(boundary)")
        return try decode(CreatedTransmission.self, data)
    }

    public func mailReview(transmissionID: String, deliveryID: String, mode: MailMode) async throws -> MailReview {
        try await get("/api/transmissions/\(transmissionID)/mail/\(deliveryID)/review?mode=\(mode.rawValue)", as: MailReview.self)
    }

    public func approveMail(transmissionID: String, deliveryID: String, mode: MailMode, reviewHash: String) async throws {
        _ = try await send("POST", "/api/transmissions/\(transmissionID)/mail/\(deliveryID)/approve",
                           body: try JSONEncoder().encode(MailApproval(mode: mode.rawValue, reviewHash: reviewHash)),
                           contentType: "application/json")
    }

    // MARK: Settings

    public func settings() async throws -> WorkerSettings { try await get("/api/settings", as: WorkerSettings.self) }

    public func updateSettings(_ update: SettingsUpdate) async throws -> WorkerSettings {
        let data = try await send("PUT", "/api/settings", body: try JSONEncoder().encode(update), contentType: "application/json")
        return try decode(WorkerSettings.self, data)
    }

    /// The route is expected by the apps but is not on every Worker build; a 404 means "not on this instance".
    public func voicemailSettings() async throws -> VoicemailSettings {
        try await get("/api/settings/voicemail", as: VoicemailSettings.self)
    }

    public func saveVoicemailSettings(_ value: VoicemailSettings) async throws -> VoicemailSettings {
        let data = try await send("PUT", "/api/settings/voicemail", body: try JSONEncoder().encode(value), contentType: "application/json")
        return (try? decode(VoicemailSettings.self, data)) ?? value
    }

    /// Hands the device's APNs token to the Worker. `platform` is ios or macos; `environment` is sandbox or production.
    public func registerPushDevice(token: String, platform: String, environment: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["token": token, "platform": platform, "environment": environment], options: [.sortedKeys])
        _ = try await send("POST", "/api/push/devices", body: body, contentType: "application/json")
    }

    // MARK: Calls

    public func calls() async throws -> [CallItem] { try await get("/api/voice/calls", as: CallsResponse.self).calls }
    public func recordings() async throws -> [Recording] { try await get("/api/voice/recordings", as: RecordingsResponse.self).recordings }

    public func markHeard(recordingID: String) async throws {
        _ = try await send("POST", "/api/voice/recordings/\(recordingID)/heard", body: nil, contentType: nil)
    }

    // MARK: Files

    /// Downloads a PDF or audio file with the bearer token into a private temp folder and returns its URL.
    /// `path` is a Worker path such as `/api/transmissions/:id/document`, not an arbitrary address.
    public func download(path: String, filename: String) async throws -> URL {
        for attempt in 0..<2 {
            let request = try await authorized("GET", path, body: nil, contentType: nil)
            let (location, response) = try await transport { try await self.urlSession.download(for: request) }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 || (300..<400).contains(status) {
                try? FileManager.default.removeItem(at: location)
                if attempt == 1 { throw APIError.sessionExpired }
                _ = try await renewAfterRejection(rejected: request)
                continue
            }
            guard (200...299).contains(status) else {
                let data = (try? Data(contentsOf: location)) ?? Data()
                try? FileManager.default.removeItem(at: location)
                throw serverError(status, data)
            }
            return try place(location, filename: filename, mime: (response as? HTTPURLResponse)?.mimeType)
        }
        throw APIError.sessionExpired
    }

    private func place(_ location: URL, filename: String, mime: String?) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("simpledocs", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var clean = filename.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        // Players pick a decoder from the extension, so a name without one gets it from the response type.
        if (clean as NSString).pathExtension.isEmpty {
            switch mime?.lowercased() {
            case "audio/wav", "audio/x-wav", "audio/wave": clean += ".wav"
            case "audio/mpeg", "audio/mp3": clean += ".mp3"
            case "application/pdf": clean += ".pdf"
            default: break
            }
        }
        let target = folder.appendingPathComponent(clean.isEmpty ? "file" : clean)
        try FileManager.default.moveItem(at: location, to: target)
        return target
    }

    /// Removes everything this client downloaded. Called on sign-out.
    public static func clearDownloads() {
        try? FileManager.default.removeItem(at: FileManager.default.temporaryDirectory.appendingPathComponent("simpledocs", isDirectory: true))
    }

    // MARK: Transport

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        try decode(type, try await send("GET", path, body: nil, contentType: nil))
    }

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw APIError.invalidResponse }
    }

    private func send(_ method: String, _ path: String, body: Data?, contentType: String?) async throws -> Data {
        for attempt in 0..<2 {
            let request = try await authorized(method, path, body: body, contentType: contentType)
            let (data, response) = try await transport { try await self.urlSession.data(for: request) }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 || (300..<400).contains(status) {
                if attempt == 1 { throw APIError.sessionExpired }
                _ = try await renewAfterRejection(rejected: request)
                continue
            }
            guard (200...299).contains(status) else { throw serverError(status, data) }
            guard data.count <= Self.jsonLimit else { throw APIError.invalidResponse }
            return data
        }
        throw APIError.sessionExpired
    }

    private func transport<T: Sendable>(_ work: @Sendable () async throws -> T) async throws -> T {
        do { return try await work() }
        catch let error as APIError { throw error }
        catch is CancellationError { throw CancellationError() }
        catch let error as URLError where error.code == .cancelled { throw CancellationError() }
        catch { throw APIError.unreachable }
    }

    private func serverError(_ status: Int, _ data: Data) -> APIError {
        let message = (try? JSONDecoder().decode(WorkerErrorBody.self, from: data))?.error
        return .server(status: status, message: message ?? "The request failed (\(status)). Try again.")
    }

    private func authorized(_ method: String, _ path: String, body: Data?, contentType: String?) async throws -> URLRequest {
        if now() >= session.expiresAt.addingTimeInterval(-30) { _ = try await renew() }
        guard let url = URL(string: origin.canonical + path), OriginBinding.permits(url, for: origin) else { throw APIError.invalidResponse }
        let token = session.accessToken
        // Reject anything that could split a header.
        guard !token.isEmpty, token.utf8.allSatisfy({ $0 >= 0x21 && $0 <= 0x7e }) else { throw APIError.sessionExpired }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json, application/pdf, audio/*", forHTTPHeaderField: "Accept")
        if method != "GET" { request.setValue(origin.canonical, forHTTPHeaderField: "Origin") }
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        request.httpBody = body
        return request
    }

    // MARK: Renewal

    /// After a 401, renew once unless another call already replaced the rejected token.
    private func renewAfterRejection(rejected: URLRequest) async throws -> StoredSession {
        if rejected.value(forHTTPHeaderField: "Authorization") != "Bearer " + session.accessToken { return session }
        return try await renew()
    }

    private func renew() async throws -> StoredSession {
        if let refreshing { return try await refreshing.value }
        guard let refresh = session.tokens.tokens.refreshToken, !refresh.isEmpty else { throw APIError.sessionExpired }
        let current = session
        let task = Task { try await self.refresh(current, refreshToken: refresh) }
        refreshing = task
        defer { refreshing = nil }
        let renewed = try await task.value
        session = renewed
        try? vault.save(renewed)
        return renewed
    }

    private func refresh(_ current: StoredSession, refreshToken: String) async throws -> StoredSession {
        let resource = origin.canonical + "/"
        var form = URLComponents()
        form.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token"),
                           URLQueryItem(name: "refresh_token", value: refreshToken),
                           URLQueryItem(name: "client_id", value: current.clientID),
                           URLQueryItem(name: "resource", value: resource)]
        guard let encoded = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B") else { throw APIError.sessionExpired }
        var request = URLRequest(url: current.tokenEndpoint)
        request.httpMethod = "POST"
        request.httpBody = Data(encoded.utf8)
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let received = now()
        let frozen = request
        let (data, response) = try await transport { try await self.urlSession.data(for: frozen) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (500...599).contains(status) { throw APIError.unreachable }
        guard status == 200, data.count <= 65_536 else { throw APIError.sessionExpired }
        struct Response: Decodable { let access_token: String; let expires_in: Int; let refresh_token: String?; let token_type: String? }
        guard let parsed = try? JSONDecoder().decode(Response.self, from: data), !parsed.access_token.isEmpty,
              parsed.access_token.utf8.count <= 16_384, parsed.expires_in > 0,
              (parsed.token_type ?? "bearer").lowercased() == "bearer" else { throw APIError.sessionExpired }
        let tokens = OAuthTokens(accessToken: parsed.access_token, refreshToken: parsed.refresh_token ?? refreshToken,
                                 expiresIn: parsed.expires_in, resource: resource)
        guard let expiring = try? ExpiringTokens(tokens: tokens, receivedAt: received) else { throw APIError.sessionExpired }
        var next = current
        next.tokens = expiring
        return next
    }
}
