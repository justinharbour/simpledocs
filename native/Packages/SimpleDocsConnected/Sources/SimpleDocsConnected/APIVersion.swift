import Foundation

public enum APIVersionNegotiation: Equatable, Sendable {
    case supported(major: Int)
    case unsupported
}

/// Picks an API major version both sides support, or refuses. The discovery document that would
/// carry the instance's list is undecided, so callers must treat any list as untrusted input.
public enum APIVersion {
    /// Majors this client implements. The v1 contract is a proposal, not a deployed API.
    public static let clientSupported: [Int] = [1]

    public static func negotiate(advertised: [Int], clientSupported: [Int] = APIVersion.clientSupported) -> APIVersionNegotiation {
        let common = Set(advertised.filter { $0 > 0 }).intersection(clientSupported)
        guard let best = common.max() else { return .unsupported }
        return .supported(major: best)
    }
}
