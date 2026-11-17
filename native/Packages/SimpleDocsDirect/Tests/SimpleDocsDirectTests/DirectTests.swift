import Foundation
import Security
import XCTest
@testable import SimpleDocsDirect

private final class FakeKeychain: KeychainAPI {
    var addStatus: OSStatus = errSecSuccess
    var copyStatus: OSStatus = errSecItemNotFound
    var updateStatus: OSStatus = errSecSuccess
    var deleteStatus: OSStatus = errSecSuccess
    var result: CFTypeRef?
    var added: [String: Any] = [:]
    var queried: [String: Any] = [:]
    var updated: [String: Any] = [:]
    var deleted: [String: Any] = [:]
    func add(_ query: CFDictionary) -> OSStatus {
        added = query as! [String: Any]; return addStatus
    }
    func copy(_ query: CFDictionary, result: UnsafeMutablePointer<CFTypeRef?>) -> OSStatus {
        queried = query as! [String: Any]; result.pointee = self.result; return copyStatus
    }
    func update(_ query: CFDictionary, attributes: CFDictionary) -> OSStatus {
        queried = query as! [String: Any]; updated = attributes as! [String: Any]; return updateStatus
    }
    func delete(_ query: CFDictionary) -> OSStatus {
        deleted = query as! [String: Any]; return deleteStatus
    }
}

final class DirectTests: XCTestCase {
    func testSaveUsesDeviceOnlyNonSyncKeychainAndProviderIdentity() throws {
        let api = FakeKeychain()
        let store = CredentialStore(api: api)
        try store.save(Data([0x01]), for: .telnyx)
        XCTAssertEqual(api.added[kSecAttrAccount as String] as? String, "telnyx")
        XCTAssertEqual(api.added[kSecAttrService as String] as? String, "dev.justinharbour.simpledocs.direct.provider")
        XCTAssertEqual(api.added[kSecAttrSynchronizable as String] as? Bool, false)
        XCTAssertEqual(api.added[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertEqual(api.added[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertThrowsError(try store.save(Data(), for: .postgrid)) { XCTAssertEqual($0 as? CredentialStoreError, .emptyCredential) }
    }

    func testDuplicateUpdatesOnlyMatchingProviderAndPropagatesFailure() throws {
        let api = FakeKeychain(); api.addStatus = errSecDuplicateItem
        let store = CredentialStore(api: api)
        try store.save(Data([0x02]), for: .postgrid)
        XCTAssertEqual(api.queried[kSecAttrAccount as String] as? String, "postgrid")
        XCTAssertNil(api.queried[kSecValueData as String])
        XCTAssertEqual(api.updated[kSecValueData as String] as? Data, Data([0x02]))
        api.updateStatus = errSecInteractionNotAllowed
        XCTAssertThrowsError(try store.save(Data([0x02]), for: .postgrid)) { XCTAssertEqual($0 as? CredentialStoreError, .keychain(errSecInteractionNotAllowed)) }
    }

    func testLoadAndDeleteHandleMissingAndErrors() throws {
        let api = FakeKeychain(); let store = CredentialStore(api: api)
        XCTAssertNil(try store.load(for: .telnyx))
        api.copyStatus = errSecSuccess; api.result = Data([0x03]) as CFData
        XCTAssertEqual(try store.load(for: .postgrid), Data([0x03]))
        XCTAssertEqual(api.queried[kSecAttrAccount as String] as? String, "postgrid")
        api.result = nil
        XCTAssertThrowsError(try store.load(for: .telnyx)) { XCTAssertEqual($0 as? CredentialStoreError, .unexpectedResult) }
        api.copyStatus = errSecInteractionNotAllowed
        XCTAssertThrowsError(try store.load(for: .telnyx)) { XCTAssertEqual($0 as? CredentialStoreError, .keychain(errSecInteractionNotAllowed)) }
        api.deleteStatus = errSecItemNotFound
        try store.delete(for: .telnyx)
        XCTAssertEqual(api.deleted[kSecAttrAccount as String] as? String, "telnyx")
        api.deleteStatus = errSecAuthFailed
        XCTAssertThrowsError(try store.delete(for: .telnyx)) { XCTAssertEqual($0 as? CredentialStoreError, .keychain(errSecAuthFailed)) }
        api.addStatus = errSecAuthFailed
        XCTAssertThrowsError(try store.save(Data([0x04]), for: .telnyx)) { XCTAssertEqual($0 as? CredentialStoreError, .keychain(errSecAuthFailed)) }
    }

    func testEveryFeatureFailsClosed() {
        for feature in DirectFeature.allCases {
            switch eligibility(for: feature) {
            case .unavailable: break
            }
        }
        XCTAssertEqual(eligibility(for: .inboundFax), .unavailable(reason: .inboundCaptureUnverified))
        XCTAssertEqual(eligibility(for: .outboundMail), .unavailable(reason: .providerIntegrationUnverified))
        XCTAssertEqual(eligibility(for: .outboundVoice), .unavailable(reason: .voiceIntegrationUnverified))
    }
}
