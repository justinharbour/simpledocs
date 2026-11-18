import Foundation
import Testing
import SimpleDocsConnected
@testable import SimpleDocsOAuth

struct Stub: Sendable {
    var status = 200
    var body = Data("{}".utf8)
    var type = "application/json"
    var fail = false
}

struct Seen: Sendable {
    var method: String
    var url: URL
    var authorization: String?
    var origin: String?
    var contentType: String?
    var cookie: String?
    var body: Data
}

/// StubProtocol keeps shared static state, so every suite that uses it nests here and runs serially.
@Suite(.serialized) enum StubbedSuites {}

/// Routes by "METHOD path" so each test can script its own answers and read back what was sent.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var routes: [String: [Stub]] = [:]
    nonisolated(unsafe) static var seen: [Seen] = []
    static let lock = NSLock()

    static func reset(_ routes: [String: [Stub]]) { lock.withLock { self.routes = routes; seen = [] } }
    static var requests: [Seen] { lock.withLock { seen } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        let key = "\(request.httpMethod ?? "GET") \(url.path)"
        let stub: Stub? = Self.lock.withLock {
            Self.seen.append(Seen(method: request.httpMethod ?? "GET", url: url,
                                  authorization: request.value(forHTTPHeaderField: "Authorization"),
                                  origin: request.value(forHTTPHeaderField: "Origin"),
                                  contentType: request.value(forHTTPHeaderField: "Content-Type"),
                                  cookie: request.value(forHTTPHeaderField: "Cookie"), body: body))
            guard var list = Self.routes[key], !list.isEmpty else { return nil }
            let first = list.removeFirst()
            if !list.isEmpty { Self.routes[key] = list }
            return first
        }
        guard let stub, !stub.fail else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: stub.status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": stub.type, "Location": "https://login.example.net/"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func json(_ text: String, status: Int = 200) -> Stub { Stub(status: status, body: Data(text.utf8)) }

private func session(token: String = "tok-1", refresh: String? = "ref-1", expiresIn: Int = 900, at: Date = Date()) throws -> StoredSession {
    let tokens = OAuthTokens(accessToken: token, refreshToken: refresh, expiresIn: expiresIn, resource: "https://one.example.com/")
    return StoredSession(instance: "https://one.example.com", issuer: "https://team.cloudflareaccess.com", clientID: "client-1",
                         tokenEndpoint: URL(string: "https://team.cloudflareaccess.com/cdn-cgi/access/oauth/token")!,
                         tokens: try ExpiringTokens(tokens: tokens, receivedAt: at))
}

private func api(_ stored: StoredSession, vault: SessionVault = MemoryVault(), now: @escaping @Sendable () -> Date = Date.init) throws -> WorkerAPI {
    try WorkerAPI(session: stored, vault: vault, protocolClasses: [StubProtocol.self], now: now)
}

extension StubbedSuites { @Suite struct WorkerAPITests {
    @Test func readsRecordsWithBearerAndNoCookie() async throws {
        StubProtocol.reset(["GET /api/records": [json(#"{"records":[{"type":"transmission","id":"t1","title":"Lease","createdAt":"2026-11-16T10:00:00Z","channels":[{"id":"d1","channel":"fax","status":"queued"}]}]}"#)]])
        let records = try await api(session()).records()
        #expect(records.map(\.id) == ["t1"])
        let sent = try #require(StubProtocol.requests.first)
        #expect(sent.authorization == "Bearer tok-1")
        #expect(sent.cookie == nil)
        #expect(sent.origin == nil)
        #expect(sent.url.absoluteString == "https://one.example.com/api/records")
    }

    @Test func writesCarryTheInstanceOrigin() async throws {
        StubProtocol.reset(["POST /api/voice/recordings/r1/heard": [json(#"{"id":"r1","heard":true}"#)],
                            "PUT /api/settings": [json(#"{"senderName":"Ada","mailFrom":null,"faxFrom":"+15125550100"}"#)]])
        let client = try api(session())
        try await client.markHeard(recordingID: "r1")
        let saved = try await client.updateSettings(SettingsUpdate(senderName: "Ada"))
        #expect(saved.senderName == "Ada")
        for sent in StubProtocol.requests { #expect(sent.origin == "https://one.example.com") }
        let body = try #require(JSONSerialization.jsonObject(with: StubProtocol.requests[1].body) as? [String: Any])
        #expect(body["senderName"] as? String == "Ada" && body["mailFrom"] == nil)
    }

    @Test func uploadsPDFAndSpecAsMultipart() async throws {
        StubProtocol.reset(["POST /api/transmissions": [Stub(status: 202, body: Data(#"{"id":"t9","deliveries":[{"id":"d1","channel":"mail","status":"awaiting_approval"}]}"#.utf8))]])
        let pdf = Data("%PDF-1.4 fake".utf8)
        let created = try await api(session()).createTransmission(pdf: pdf, filename: "a\"b.pdf", spec: Data(#"{"title":"x"}"#.utf8))
        #expect(created.deliveries.first?.status == "awaiting_approval")
        let sent = try #require(StubProtocol.requests.first)
        let type = try #require(sent.contentType)
        #expect(type.hasPrefix("multipart/form-data; boundary="))
        let text = String(decoding: sent.body, as: UTF8.self)
        #expect(text.contains(#"name="document"; filename="ab.pdf""#))
        #expect(text.contains("Content-Type: application/pdf"))
        #expect(text.contains(#"name="spec""#) && text.contains(#"{"title":"x"}"#))
        #expect(text.contains("%PDF-1.4 fake"))
    }

    @Test func approvalBodyHasExactlyTheThreeKeys() async throws {
        StubProtocol.reset(["POST /api/transmissions/t1/mail/d1/approve": [Stub(status: 202, body: Data(#"{"id":"d1","status":"queued"}"#.utf8))]])
        try await api(session()).approveMail(transmissionID: "t1", deliveryID: "d1", mode: .live, reviewHash: String(repeating: "a", count: 64))
        let body = try #require(JSONSerialization.jsonObject(with: StubProtocol.requests[0].body) as? [String: Any])
        #expect(Set(body.keys) == ["confirmed", "mode", "reviewHash"])
        #expect(body["confirmed"] as? Bool == true && body["mode"] as? String == "live")
    }

    @Test func serverErrorsKeepTheWorkersMessage() async throws {
        StubProtocol.reset(["GET /api/settings": [json(#"{"error":"Storage unavailable"}"#, status: 503)]])
        await #expect(throws: APIError.server(status: 503, message: "Storage unavailable")) { try await api(session()).settings() }
        StubProtocol.reset(["GET /api/settings/voicemail": [Stub(status: 404, body: Data("<html>".utf8), type: "text/html")]])
        await #expect(throws: APIError.server(status: 404, message: "The request failed (404). Try again.")) { try await api(session()).voicemailSettings() }
    }

    @Test func networkFailureMapsToUnreachable() async throws {
        StubProtocol.reset(["GET /api/records": [Stub(fail: true)]])
        await #expect(throws: APIError.unreachable) { try await api(session()).records() }
    }

    @Test func garbageBodyIsInvalidResponse() async throws {
        StubProtocol.reset(["GET /api/records": [json("not json")]])
        await #expect(throws: APIError.invalidResponse) { try await api(session()).records() }
    }

    @Test func unauthorizedRefreshesOnceThenRetriesWithNewToken() async throws {
        let vault = MemoryVault()
        StubProtocol.reset([
            "GET /api/records": [json("{}", status: 401), json(#"{"records":[]}"#)],
            "POST /cdn-cgi/access/oauth/token": [json(#"{"access_token":"tok-2","token_type":"Bearer","expires_in":900,"refresh_token":"ref-2"}"#)],
        ])
        let client = try api(session(), vault: vault)
        #expect(try await client.records().isEmpty)
        let auth = StubProtocol.requests.map(\.authorization)
        #expect(auth[0] == "Bearer tok-1" && auth[2] == "Bearer tok-2")
        let refresh = try #require(StubProtocol.requests.first { $0.url.path.hasSuffix("/token") })
        let form = String(decoding: refresh.body, as: UTF8.self)
        #expect(form.contains("grant_type=refresh_token") && form.contains("refresh_token=ref-1") && form.contains("client_id=client-1"))
        #expect(refresh.authorization == nil)
        let stored = try #require(vault.load(instance: "https://one.example.com"))
        #expect(stored.accessToken == "tok-2" && stored.tokens.tokens.refreshToken == "ref-2")
    }

    @Test func redirectToLoginMeansSessionExpired() async throws {
        StubProtocol.reset(["GET /api/records": [Stub(status: 302), Stub(status: 302)],
                            "POST /cdn-cgi/access/oauth/token": [json("{}", status: 400)]])
        await #expect(throws: APIError.sessionExpired) { try await api(session()).records() }
    }

    @Test func failedRefreshMeansSessionExpiredAndNeverLoops() async throws {
        StubProtocol.reset(["GET /api/records": [json("{}", status: 401), json("{}", status: 401)],
                            "POST /cdn-cgi/access/oauth/token": [json(#"{"error":"invalid_grant"}"#, status: 400)]])
        await #expect(throws: APIError.sessionExpired) { try await api(session()).records() }
        #expect(StubProtocol.requests.count == 2)
    }

    @Test func noRefreshTokenMeansSessionExpired() async throws {
        StubProtocol.reset(["GET /api/records": [json("{}", status: 401)]])
        await #expect(throws: APIError.sessionExpired) { try await api(session(refresh: nil)).records() }
    }

    @Test func expiredTokenIsRenewedBeforeTheCall() async throws {
        let issued = Date(timeIntervalSince1970: 1_000_000)
        StubProtocol.reset([
            "POST /cdn-cgi/access/oauth/token": [json(#"{"access_token":"tok-2","token_type":"Bearer","expires_in":900}"#)],
            "GET /api/settings": [json(#"{"senderName":"A","mailFrom":null,"faxFrom":null}"#)],
        ])
        let client = try api(session(expiresIn: 60, at: issued), now: { issued.addingTimeInterval(3600) })
        _ = try await client.settings()
        #expect(StubProtocol.requests.map(\.url.path) == ["/cdn-cgi/access/oauth/token", "/api/settings"])
        #expect(StubProtocol.requests[1].authorization == "Bearer tok-2")
        #expect(await client.session.tokens.tokens.refreshToken == "ref-1")
    }

    @Test func downloadsAuthenticatedFileToTempFolder() async throws {
        StubProtocol.reset(["GET /api/voice/recordings/r1": [Stub(status: 200, body: Data("RIFFdata".utf8), type: "audio/wav")]])
        let url = try await api(session()).download(path: "/api/voice/recordings/r1", filename: "voicemail.wav")
        defer { WorkerAPI.clearDownloads() }
        #expect(url.lastPathComponent == "voicemail.wav")
        #expect(try Data(contentsOf: url) == Data("RIFFdata".utf8))
        #expect(StubProtocol.requests.first?.authorization == "Bearer tok-1")
    }

    @Test func downloadNameGetsExtensionFromContentType() async throws {
        StubProtocol.reset(["GET /api/voice/recordings/r2": [Stub(status: 200, body: Data("ID3".utf8), type: "audio/mpeg")]])
        let url = try await api(session()).download(path: "/api/voice/recordings/r2", filename: "Voicemail")
        defer { WorkerAPI.clearDownloads() }
        #expect(url.lastPathComponent == "Voicemail.mp3")
    }

    @Test func downloadFailureDoesNotLeaveAFile() async throws {
        StubProtocol.reset(["GET /api/transmissions/t1/document": [json(#"{"error":"Not found"}"#, status: 404)]])
        await #expect(throws: APIError.server(status: 404, message: "Not found")) {
            try await api(session()).download(path: "/api/transmissions/t1/document", filename: "d.pdf")
        }
    }

    @Test func registersPushDeviceWithOriginAndJSONBody() async throws {
        StubProtocol.reset(["POST /api/push/devices": [Stub(status: 200, body: Data("{}".utf8))]])
        let api = try api(try session())
        try await api.registerPushDevice(token: String(repeating: "ab", count: 32), platform: "macos", environment: "sandbox")
        let sent = try #require(StubProtocol.requests.first)
        #expect(sent.origin == "https://one.example.com")
        let body = try #require(JSONSerialization.jsonObject(with: sent.body) as? [String: String])
        #expect(body == ["token": String(repeating: "ab", count: 32), "platform": "macos", "environment": "sandbox"])
    }

    @Test func clientRefusesAMalformedInstance() throws {
        var bad = try session()
        bad.instance = "http://one.example.com"
        #expect(throws: APIError.invalidResponse) { try WorkerAPI(session: bad, vault: MemoryVault()) }
    }
}
}
