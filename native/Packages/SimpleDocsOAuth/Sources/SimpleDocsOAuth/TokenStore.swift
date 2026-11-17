import Foundation
import Security
import SimpleDocsConnected

public enum TokenStoreError: Error, Equatable { case staleContext, invalidResource, keychain(OSStatus) }

/// Synchronous Keychain access must be coordinated with the live registry by the caller on one actor.
/// A link's random identifier and origin digest determine the Keychain account; no global item is used.
public enum TokenStore {
    private static let service = "dev.simpledocs.instance-oauth"

    private static func key(registry: InstanceRegistry, binding: ContextBinding) throws -> [String: Any] {
        guard registry.isCurrent(binding), let active = registry.active else { throw TokenStoreError.staleContext }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                kSecAttrAccount as String: active.scope.keychainAccount,
                kSecAttrSynchronizable as String: false]
    }

    public static func save(_ tokens: OAuthTokens, registry: InstanceRegistry, binding: ContextBinding) throws {
        var query = try key(registry: registry, binding: binding)
        guard tokens.resource == registry.active!.scope.origin.canonical + "/" else { throw TokenStoreError.invalidResource }
        let data = try JSONEncoder().encode(tokens)
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw TokenStoreError.keychain(status) }
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let added = SecItemAdd(query as CFDictionary, nil)
        guard added == errSecSuccess else { throw TokenStoreError.keychain(added) }
    }

    public static func load(registry: InstanceRegistry, binding: ContextBinding) throws -> OAuthTokens? {
        var query = try key(registry: registry, binding: binding)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw TokenStoreError.keychain(status) }
        let tokens = try JSONDecoder().decode(OAuthTokens.self, from: data)
        guard tokens.resource == registry.active!.scope.origin.canonical + "/" else { throw TokenStoreError.invalidResource }
        return tokens
    }

    public static func delete(registry: InstanceRegistry, binding: ContextBinding) throws {
        let status = SecItemDelete(try key(registry: registry, binding: binding) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw TokenStoreError.keychain(status) }
    }

    /// The caller must obtain this scope from the still-linked registry, and serialize unlinking.
    public static func delete(scope: SessionScope) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: scope.keychainAccount,
            kSecAttrSynchronizable as String: false]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw TokenStoreError.keychain(status) }
    }
}
