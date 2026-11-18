import Foundation
import Security

/// Everything needed to keep calling one instance and renew its token without signing in again.
/// The access and refresh tokens live only in the Keychain, never in UserDefaults or logs.
public struct StoredSession: Codable, Sendable, Equatable {
    public var instance: String
    public var issuer: String
    public var clientID: String
    public var tokenEndpoint: URL
    public var tokens: ExpiringTokens

    public var accessToken: String { tokens.tokens.accessToken }
    public var expiresAt: Date { tokens.expiresAt }

    public init(instance: String, issuer: String, clientID: String, tokenEndpoint: URL, tokens: ExpiringTokens) {
        self.instance = instance; self.issuer = issuer; self.clientID = clientID
        self.tokenEndpoint = tokenEndpoint; self.tokens = tokens
    }
}

extension ExpiringTokens: Equatable {
    public static func == (lhs: ExpiringTokens, rhs: ExpiringTokens) -> Bool {
        lhs.expiresAt == rhs.expiresAt && lhs.tokens.accessToken == rhs.tokens.accessToken
            && lhs.tokens.refreshToken == rhs.tokens.refreshToken
    }
}

/// One stored session per instance origin, so the last instance can be restored on the next launch.
public protocol SessionVault: Sendable {
    func load(instance: String) -> StoredSession?
    func save(_ session: StoredSession) throws
    func delete(instance: String)
}

public struct KeychainVault: SessionVault {
    private static let service = "dev.simpledocs.session"
    public init() {}

    private func query(_ instance: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service,
         kSecAttrAccount as String: instance, kSecAttrSynchronizable as String: false]
    }

    public func load(instance: String) -> StoredSession? {
        var q = query(instance)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data,
              let session = try? JSONDecoder().decode(StoredSession.self, from: data),
              session.instance == instance else { return nil }
        return session
    }

    public func save(_ session: StoredSession) throws {
        let data = try JSONEncoder().encode(session)
        var q = query(session.instance)
        let status = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw TokenStoreError.keychain(status) }
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let added = SecItemAdd(q as CFDictionary, nil)
        guard added == errSecSuccess else { throw TokenStoreError.keychain(added) }
    }

    public func delete(instance: String) {
        SecItemDelete(query(instance) as CFDictionary)
    }
}

/// In-memory vault for tests and previews of the model layer.
public final class MemoryVault: SessionVault, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: StoredSession] = [:]
    public init() {}
    public func load(instance: String) -> StoredSession? { lock.withLock { items[instance] } }
    public func save(_ session: StoredSession) throws { lock.withLock { items[session.instance] = session } }
    public func delete(instance: String) { lock.withLock { items[instance] = nil } }
}
