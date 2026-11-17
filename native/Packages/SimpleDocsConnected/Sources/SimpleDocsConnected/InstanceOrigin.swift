import Foundation

public enum InstanceOriginError: Error, Equatable, Sendable {
    case empty
    case tooLong
    case invalidCharacters
    case missingScheme
    case schemeNotHTTPS
    case credentialsNotAllowed
    case pathNotAllowed
    case queryOrFragmentNotAllowed
    case missingHost
    case invalidHost
    case ipAddressNotAllowed
    case localOrReservedHostNotAllowed
    case invalidPort

    public var message: String {
        switch self {
        case .empty: "Enter the address of your instance."
        case .tooLong: "The address is too long."
        case .invalidCharacters: "The address can only contain visible ASCII characters. Use the punycode form for international names."
        case .missingScheme: "Start the address with https://."
        case .schemeNotHTTPS: "Only https addresses are accepted."
        case .credentialsNotAllowed: "Do not put a user name or password in the address."
        case .pathNotAllowed: "Enter the host name only, without a path."
        case .queryOrFragmentNotAllowed: "Remove anything after the host name, such as a query or fragment."
        case .missingHost: "The address needs a host name."
        case .invalidHost: "The host name is not valid."
        case .ipAddressNotAllowed: "IP addresses are not accepted. Use the instance's DNS name."
        case .localOrReservedHostNotAllowed: "Local and reserved host names are not accepted."
        case .invalidPort: "The port number is not valid."
        }
    }
}

/// A validated, canonical https origin chosen by the user for one instance.
///
/// Parsing is strict and deliberately independent of `URL`/`URLComponents` leniency. It never
/// contacts the address: a valid origin says nothing about whether a simpledocs instance exists there.
public struct InstanceOrigin: Hashable, Sendable, CustomStringConvertible {
    public let host: String
    /// `nil` means the default https port (443).
    public let port: Int?

    public var effectivePort: Int { port ?? 443 }

    /// `https://host` or `https://host:port`, lowercase, with no trailing slash.
    public var canonical: String {
        port.map { "https://\(host):\($0)" } ?? "https://\(host)"
    }

    public var description: String { canonical }

    /// True if any label is punycode. The UI should show the origin prominently for confirmation.
    public var hasPunycodeLabel: Bool {
        host.split(separator: ".").contains { $0.hasPrefix("xn--") }
    }

    public var url: URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.port = port
        // Components were validated at parse time; a failure here is a programming error.
        guard let url = components.url else { preconditionFailure("validated origin produced no URL") }
        return url
    }

    private init(host: String, port: Int?) {
        self.host = host
        self.port = port
    }

    public static func parse(_ input: String) -> Result<InstanceOrigin, InstanceOriginError> {
        do { return .success(try parseThrowing(input)) } catch let error as InstanceOriginError {
            return .failure(error)
        } catch { return .failure(.invalidHost) }
    }

    private static let reservedSuffixes = ["localhost", "local", "internal", "localdomain", "lan", "invalid", "home.arpa"]

    private static func parseThrowing(_ input: String) throws -> InstanceOrigin {
        // Only ASCII whitespace is trimmed: Unicode trimming would silently drop invisible characters.
        let trimmed = input.trimmingCharacters(in: CharacterSet(charactersIn: " \t\r\n"))
        guard !trimmed.isEmpty else { throw InstanceOriginError.empty }
        guard trimmed.utf8.count <= 2048 else { throw InstanceOriginError.tooLong }
        guard trimmed.unicodeScalars.allSatisfy({ (0x21...0x7E).contains($0.value) }) else {
            throw InstanceOriginError.invalidCharacters
        }
        guard !trimmed.contains("\\") else { throw InstanceOriginError.invalidCharacters }

        guard let separator = trimmed.range(of: "://") else { throw InstanceOriginError.missingScheme }
        let scheme = trimmed[..<separator.lowerBound]
        guard !scheme.isEmpty, scheme.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "+-.".contains($0)) }),
              scheme.first?.isLetter == true
        else { throw InstanceOriginError.missingScheme }
        guard scheme.lowercased() == "https" else { throw InstanceOriginError.schemeNotHTTPS }

        let rest = trimmed[separator.upperBound...]
        let boundary = rest.firstIndex(where: { "/?#".contains($0) }) ?? rest.endIndex
        let authority = rest[..<boundary]
        let tail = rest[boundary...]
        if !tail.isEmpty && tail != "/" {
            let body = tail.hasPrefix("/") ? tail.dropFirst() : tail
            if body.first == "?" || body.first == "#" { throw InstanceOriginError.queryOrFragmentNotAllowed }
            throw InstanceOriginError.pathNotAllowed
        }

        guard !authority.contains("@") else { throw InstanceOriginError.credentialsNotAllowed }
        guard !authority.contains("%") else { throw InstanceOriginError.invalidHost }
        guard !authority.contains("[") && !authority.contains("]") else { throw InstanceOriginError.ipAddressNotAllowed }

        let parts = authority.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count <= 2 else { throw InstanceOriginError.invalidHost }
        let hostPart = String(parts[0]).lowercased()
        var port: Int?
        if parts.count == 2 {
            let digits = parts[1]
            guard !digits.isEmpty, digits.count <= 5, digits.allSatisfy({ $0.isASCII && $0.isNumber }),
                  digits.first != "0", let value = Int(digits), (1...65_535).contains(value)
            else { throw InstanceOriginError.invalidPort }
            port = value == 443 ? nil : value
        }

        try validate(host: hostPart)
        return InstanceOrigin(host: hostPart, port: port)
    }

    private static func validate(host: String) throws {
        guard !host.isEmpty else { throw InstanceOriginError.missingHost }
        guard host.utf8.count <= 253 else { throw InstanceOriginError.invalidHost }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        for label in labels {
            guard (1...63).contains(label.utf8.count),
                  label.allSatisfy({ $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "-") }),
                  label.first != "-", label.last != "-"
            else { throw InstanceOriginError.invalidHost }
        }
        // Top-level domains never start with a digit, which rejects dotted, short and hex IPv4 forms.
        if let last = labels.last, last.first?.isNumber == true { throw InstanceOriginError.ipAddressNotAllowed }
        guard labels.count >= 2 else { throw InstanceOriginError.localOrReservedHostNotAllowed }
        if reservedSuffixes.contains(where: { host == $0 || host.hasSuffix("." + $0) }) {
            throw InstanceOriginError.localOrReservedHostNotAllowed
        }
    }
}
