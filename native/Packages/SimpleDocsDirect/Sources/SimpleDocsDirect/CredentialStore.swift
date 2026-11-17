import Foundation
import Security

/// The provider is an identifier, not a credential or a provider integration.
public enum DirectProvider: String, Sendable {
    case telnyx
    case postgrid
}

public enum CredentialStoreError: Error, Equatable {
    case emptyCredential
    case unexpectedResult
    case keychain(OSStatus)
}

protocol KeychainAPI {
    func add(_ query: CFDictionary) -> OSStatus
    func copy(_ query: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>) -> OSStatus
    func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus
    func delete(_ query: CFDictionary) -> OSStatus
}

private struct SystemKeychain: KeychainAPI {
    func add(_ query: CFDictionary) -> OSStatus { SecItemAdd(query, nil) }
    func copy(_ query: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>) -> OSStatus {
        SecItemCopyMatching(query, result)
    }
    func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus {
        SecItemUpdate(query, attributes)
    }
    func delete(_ query: CFDictionary) -> OSStatus { SecItemDelete(query) }
}

/// Stores one opaque credential per provider in the current user's Keychain.
/// Never log input, returned data, or dictionaries passed to Security.
public struct CredentialStore {
    private let api: any KeychainAPI
    private let service = "dev.justinharbour.simpledocs.direct.provider"

    public init() { api = SystemKeychain() }
    init(api: any KeychainAPI) { self.api = api }

    private func identity(_ provider: DirectProvider) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: provider.rawValue,
         kSecAttrSynchronizable as String: false]
    }

    public func save(_ data: Data, for provider: DirectProvider) throws {
        guard !data.isEmpty else { throw CredentialStoreError.emptyCredential }
        let query = identity(provider)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = api.add(item as CFDictionary)
        if status == errSecDuplicateItem {
            let attributes: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ]
            let updateStatus = api.update(query as CFDictionary, attributes: attributes as CFDictionary)
            guard updateStatus == errSecSuccess else { throw CredentialStoreError.keychain(updateStatus) }
        } else if status != errSecSuccess {
            throw CredentialStoreError.keychain(status)
        }
    }

    public func load(for provider: DirectProvider) throws -> Data? {
        var query = identity(provider)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = api.copy(query as CFDictionary, result: &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        guard let data = result as? Data, !data.isEmpty else { throw CredentialStoreError.unexpectedResult }
        return data
    }

    public func delete(for provider: DirectProvider) throws {
        let status = api.delete(identity(provider) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.keychain(status)
        }
    }
}
