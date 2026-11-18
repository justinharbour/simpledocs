import Foundation
import Security

enum TVAPIError: Error {
    case unauthorized
    case pending
    case slowDown
    case expired
    case unavailable
}

struct TVPairingCode: Codable, Sendable {
    let deviceCode: String
    let userCode: String
    let verificationUri: String
    let expiresIn: Int
    let interval: Int
}

struct TVDashboard: Codable, Sendable {
    struct Phone: Codable, Sendable { let online: Bool; let availability: String }
    struct Counts: Codable, Sendable { let ringing: Int; let answered: Int; let missed: Int; let voicemail: Int }
    struct Calls: Codable, Sendable { let last24h: Counts }
    struct Inbox: Codable, Sendable { let unreadFax: Int; let unreadVoicemail: Int }
    struct Send: Codable, Sendable { let title: String; let createdAt: String; let channel: String; let status: String }

    let generatedAt: String
    let phone: Phone
    let calls: Calls?
    let inbox: Inbox?
    let pendingApprovals: Int
    let recentSends: [Send]
}

struct TVPage<Item: Codable & Sendable>: Codable, Sendable {
    let items: [Item]
    let nextCursor: String?
}

struct TVActivityItem: Codable, Sendable, Identifiable {
    let kind: String
    let itemID: String
    let at: String
    let title: String
    let outcome: String?

    var id: String { kind + ":" + itemID }

    enum CodingKeys: String, CodingKey {
        case kind, title, at, outcome
        case itemID = "id"
    }
}

struct TVDocument: Codable, Sendable, Identifiable, Hashable {
    let id: String
    let type: String
    let title: String
    let pageCount: Int?
    let at: String
}

private struct TVErrorBody: Decodable { let error: String }

struct TVClient: Sendable {
    static let origin = "https://simpledocs.justinharbour.com"
    private let session = URLSession.shared

    func start(deviceName: String) async throws -> TVPairingCode {
        let body = try JSONEncoder().encode(["deviceName": deviceName])
        let data = try await fetch("POST", "/tv/pair/start", body: body)
        return try JSONDecoder().decode(TVPairingCode.self, from: data)
    }

    func poll(deviceCode: String) async throws -> String {
        let body = try JSONEncoder().encode(["deviceCode": deviceCode])
        let data = try await fetch("POST", "/tv/pair/poll", body: body)
        return try JSONDecoder().decode(TokenBody.self, from: data).accessToken
    }

    func get<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = [], token: String) async throws -> T {
        let data = try await fetch("GET", path, query: query, token: token)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func data(_ path: String, token: String) async throws -> Data {
        try await fetch("GET", path, token: token)
    }

    private struct TokenBody: Decodable { let accessToken: String }

    private func fetch(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, token: String? = nil) async throws -> Data {
        var components = URLComponents(string: Self.origin + path)
        components?.queryItems = query.isEmpty ? nil : query
        guard let url = components?.url else { throw TVAPIError.unavailable }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }

        let result: (Data, URLResponse)
        do { result = try await session.data(for: request) } catch { throw TVAPIError.unavailable }
        let (data, response) = result
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return data }
        if status == 401 { throw TVAPIError.unauthorized }
        switch (try? JSONDecoder().decode(TVErrorBody.self, from: data))?.error {
        case "authorization_pending": throw TVAPIError.pending
        case "slow_down": throw TVAPIError.slowDown
        case "expired_token": throw TVAPIError.expired
        default: throw TVAPIError.unavailable
        }
    }
}

enum TVTokenStore {
    private static func base() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.justinharbour.simpledocs.tv",
            kSecAttrAccount as String: "device-token",
        ]
    }

    static func load() -> String? {
        var query = base()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func save(_ token: String) -> Bool {
        var query = base()
        SecItemDelete(query as CFDictionary)
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        SecItemDelete(base() as CFDictionary)
    }
}

enum TVTime {
    static func date(_ value: String) -> Date? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: value) { return date }
        iso.formatOptions = [.withInternetDateTime]
        if let date = iso.date(from: value) { return date }
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.date(from: value)
    }

    static func short(_ value: String) -> String {
        date(value).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? ""
    }
}
