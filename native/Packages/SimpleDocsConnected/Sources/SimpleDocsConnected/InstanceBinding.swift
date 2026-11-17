import CryptoKit
import Foundation

/// Local identity of one link between this app and one instance. It is generated on the device
/// and means nothing to any server. Unlinking and relinking the same origin yields a new value,
/// so state that belonged to the earlier link cannot be mistaken for the new one.
public struct InstanceLinkID: Hashable, Sendable, CustomStringConvertible {
    public let rawValue: UUID

    public init(_ rawValue: UUID = UUID()) {
        self.rawValue = rawValue
    }

    public var description: String { rawValue.uuidString.lowercased() }
}

/// Proof that the person was shown a specific origin and accepted it. The acknowledged text must
/// equal the canonical origin, so a caller cannot confirm one string and link another.
public struct ConfirmedOrigin: Sendable, Equatable {
    public let origin: InstanceOrigin

    public init?(origin: InstanceOrigin, acknowledgedDisplay: String) {
        guard acknowledgedDisplay == origin.canonical else { return nil }
        self.origin = origin
    }
}

/// Names for everything stored on this device on behalf of one linked instance. This type only
/// computes names. It does not read or write the Keychain or the file system, and it never holds
/// a credential.
public struct SessionScope: Hashable, Sendable {
    public let linkID: InstanceLinkID
    public let origin: InstanceOrigin

    public init(linkID: InstanceLinkID, origin: InstanceOrigin) {
        self.linkID = linkID
        self.origin = origin
    }

    /// Hex SHA-256 of the canonical origin. Safe to use in a file name.
    public var originDigest: String {
        SHA256.hash(data: Data(origin.canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Keychain account name for this link's session material. It contains the link and the origin
    /// digest, so an item for one instance can never be returned for another.
    public var keychainAccount: String {
        "instance-session.\(originDigest).\(linkID)"
    }

    /// Relative directory components for cached records, proofs and artifacts of this link.
    public var cachePathComponents: [String] {
        ["instances", originDigest, linkID.description]
    }

    /// Scope for client-generated idempotency keys. Keys are never valid across links.
    public var idempotencyNamespace: String {
        "\(originDigest).\(linkID)"
    }
}

/// Decides whether a URL belongs to an instance. Used for every request target and every redirect.
public enum OriginBinding {
    /// True only for an https URL whose scheme, host and effective port equal the origin's, with
    /// no user information. Redirects get no exemption: a redirect target is checked the same way.
    public static func permits(_ url: URL, for origin: InstanceOrigin) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "https",
              components.user == nil, components.password == nil,
              let host = components.host?.lowercased(),
              host == origin.host,
              (components.port ?? 443) == origin.effectivePort
        else { return false }
        return true
    }
}

extension InstanceOrigin {
    /// Builds a URL under `/api/v1/` for this origin. Segments are individually validated, so a
    /// caller cannot traverse out of the API prefix, smuggle a query or switch host.
    public func apiURL(segments: [String]) -> URL? {
        guard !segments.isEmpty else { return nil }
        for segment in segments {
            guard !segment.isEmpty, segment != ".", segment != "..",
                  segment.utf8.count <= 128,
                  segment.unicodeScalars.allSatisfy({ scalar in
                      (0x30...0x39).contains(scalar.value) || (0x41...0x5A).contains(scalar.value)
                          || (0x61...0x7A).contains(scalar.value) || "-._~".unicodeScalars.contains(scalar)
                  })
            else { return nil }
        }
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.port = port
        components.percentEncodedPath = "/api/v1/" + segments.joined(separator: "/")
        return components.url
    }
}
