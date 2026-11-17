import Foundation
import Testing
@testable import SimpleDocsConnected

@Suite struct InstanceOriginTests {
    private func origin(_ input: String) throws -> InstanceOrigin {
        try InstanceOrigin.parse(input).get()
    }

    @Test func acceptsAndCanonicalizes() throws {
        #expect(try origin(" https://Docs.Example.com ").canonical == "https://docs.example.com")
        #expect(try origin("HTTPS://docs.example.com/").canonical == "https://docs.example.com")
        #expect(try origin("https://docs.example.com:8443").canonical == "https://docs.example.com:8443")
        #expect(try origin("https://docs.example.com:443").canonical == "https://docs.example.com")
        #expect(try origin("https://docs.example.com:443") == origin("https://docs.example.com"))
        #expect(try origin("https://a.b.workers.dev").effectivePort == 443)
    }

    @Test func urlRoundTrips() throws {
        let value = try origin("https://docs.example.com:8443")
        #expect(value.url.absoluteString == "https://docs.example.com:8443")
    }

    @Test(arguments: [
        ("", InstanceOriginError.empty),
        ("   ", .empty),
        ("docs.example.com", .missingScheme),
        ("//docs.example.com", .missingScheme),
        ("://docs.example.com", .missingScheme),
        ("http://docs.example.com", .schemeNotHTTPS),
        ("ftp://docs.example.com", .schemeNotHTTPS),
        ("javascript://docs.example.com", .schemeNotHTTPS),
        ("https://", .missingHost),
        ("https://user@docs.example.com", .credentialsNotAllowed),
        ("https://user:pass@docs.example.com", .credentialsNotAllowed),
        ("https://docs.example.com@evil.example", .credentialsNotAllowed),
        ("https://docs.example.com/app", .pathNotAllowed),
        ("https://docs.example.com//evil.example", .pathNotAllowed),
        ("https://docs.example.com?x=1", .queryOrFragmentNotAllowed),
        ("https://docs.example.com/?x=1", .queryOrFragmentNotAllowed),
        ("https://docs.example.com#frag", .queryOrFragmentNotAllowed),
        ("https://docs example.com", .invalidCharacters),
        ("https://docs.example.com\\@evil.example", .invalidCharacters),
        ("https://docs.example.com:0", .invalidPort),
        ("https://docs.example.com:99999", .invalidPort),
        ("https://docs.example.com:80a", .invalidPort),
        ("https://docs.example.com:", .invalidPort),
        ("https://docs.example.com:+443", .invalidPort),
        ("https://docs.example.com:0443", .invalidPort),
        ("https://docs.example.com:1:2", .invalidHost),
        ("https://127.0.0.1", .ipAddressNotAllowed),
        ("https://10.0.0.1:8443", .ipAddressNotAllowed),
        ("https://2130706433", .ipAddressNotAllowed),
        ("https://0x7f.0.0.1", .ipAddressNotAllowed),
        ("https://[::1]", .ipAddressNotAllowed),
        ("https://[::1]:443", .ipAddressNotAllowed),
        ("https://localhost", .localOrReservedHostNotAllowed),
        ("https://printer.local", .localOrReservedHostNotAllowed),
        ("https://svc.internal", .localOrReservedHostNotAllowed),
        ("https://app.localhost", .localOrReservedHostNotAllowed),
        ("https://intranet", .localOrReservedHostNotAllowed),
        ("https://docs.example.com.", .invalidHost),
        ("https://.example.com", .invalidHost),
        ("https://docs..example.com", .invalidHost),
        ("https://-docs.example.com", .invalidHost),
        ("https://docs_x.example.com", .invalidHost),
        ("https://docs.example.com%2f", .invalidHost),
        ("https://exämple.com", .invalidCharacters),
        ("https://docs.example.com\u{200B}", .invalidCharacters),
    ])
    func rejects(input: String, expected: InstanceOriginError) {
        #expect(InstanceOrigin.parse(input) == .failure(expected))
    }

    @Test func rejectsOverlongInputAndLabels() {
        let longLabel = String(repeating: "a", count: 64)
        #expect(InstanceOrigin.parse("https://\(longLabel).example.com") == .failure(.invalidHost))
        #expect(InstanceOrigin.parse("https://" + String(repeating: "a", count: 3000) + ".com") == .failure(.tooLong))
    }

    @Test func embeddedControlCharactersAreRejectedButSurroundingAsciiWhitespaceIsTrimmed() {
        #expect(InstanceOrigin.parse("https://docs.example.com\n.evil.example") == .failure(.invalidCharacters))
        #expect(InstanceOrigin.parse("https://docs.example.com\t") == .success(try! InstanceOrigin.parse("https://docs.example.com").get()))
    }

    @Test func punycodeIsAllowedAndFlagged() throws {
        let value = try origin("https://xn--exmple-cua.com")
        #expect(value.hasPunycodeLabel)
        #expect(!(try origin("https://docs.example.com")).hasPunycodeLabel)
    }

    @Test func everyRejectionHasAMessage() {
        for error in [InstanceOriginError.empty, .tooLong, .invalidCharacters, .missingScheme, .schemeNotHTTPS,
                      .credentialsNotAllowed, .pathNotAllowed, .queryOrFragmentNotAllowed, .missingHost,
                      .invalidHost, .ipAddressNotAllowed, .localOrReservedHostNotAllowed, .invalidPort] {
            #expect(!error.message.isEmpty)
        }
    }
}

@Suite struct OriginBindingTests {
    private let instance = try! InstanceOrigin.parse("https://docs.example.com").get()

    @Test func permitsSameOriginOnly() {
        #expect(OriginBinding.permits(URL(string: "https://docs.example.com/api/v1/capabilities")!, for: instance))
        #expect(OriginBinding.permits(URL(string: "https://DOCS.example.com:443/x")!, for: instance))
        #expect(!OriginBinding.permits(URL(string: "http://docs.example.com/")!, for: instance))
        #expect(!OriginBinding.permits(URL(string: "https://docs.example.com:8443/")!, for: instance))
        #expect(!OriginBinding.permits(URL(string: "https://evil.example/")!, for: instance))
        #expect(!OriginBinding.permits(URL(string: "https://docs.example.com.evil.example/")!, for: instance))
        #expect(!OriginBinding.permits(URL(string: "https://sub.docs.example.com/")!, for: instance))
        #expect(!OriginBinding.permits(URL(string: "https://user@docs.example.com/")!, for: instance))
        #expect(!OriginBinding.permits(URL(string: "https://docs.example.com@evil.example/")!, for: instance))
        #expect(!OriginBinding.permits(URL(string: "file:///etc/passwd")!, for: instance))
    }

    @Test func customPortMustMatch() throws {
        let custom = try InstanceOrigin.parse("https://docs.example.com:8443").get()
        #expect(OriginBinding.permits(URL(string: "https://docs.example.com:8443/a")!, for: custom))
        #expect(!OriginBinding.permits(URL(string: "https://docs.example.com/a")!, for: custom))
    }

    @Test func apiURLStaysUnderPrefix() {
        #expect(instance.apiURL(segments: ["jobs", "abc-123"])?.absoluteString == "https://docs.example.com/api/v1/jobs/abc-123")
        #expect(instance.apiURL(segments: [])  == nil)
        #expect(instance.apiURL(segments: [".."]) == nil)
        #expect(instance.apiURL(segments: ["jobs", "a/b"]) == nil)
        #expect(instance.apiURL(segments: ["jobs", "a?b"]) == nil)
        #expect(instance.apiURL(segments: ["jobs", "a%2fb"]) == nil)
        #expect(instance.apiURL(segments: ["jobs", ""]) == nil)
        #expect(instance.apiURL(segments: ["jobs", "a b"]) == nil)
        if let url = instance.apiURL(segments: ["capabilities"]) {
            #expect(OriginBinding.permits(url, for: instance))
        }
    }
}

@Suite struct ConfirmedOriginTests {
    @Test func confirmationMustMatchDisplayedOrigin() throws {
        let value = try InstanceOrigin.parse("https://docs.example.com").get()
        #expect(ConfirmedOrigin(origin: value, acknowledgedDisplay: "https://docs.example.com") != nil)
        #expect(ConfirmedOrigin(origin: value, acknowledgedDisplay: "https://docs.example.com/") == nil)
        #expect(ConfirmedOrigin(origin: value, acknowledgedDisplay: "https://evil.example") == nil)
        #expect(ConfirmedOrigin(origin: value, acknowledgedDisplay: "") == nil)
    }
}

@Suite struct APIVersionTests {
    @Test func picksHighestCommonMajor() {
        #expect(APIVersion.negotiate(advertised: [1, 2], clientSupported: [1]) == .supported(major: 1))
        #expect(APIVersion.negotiate(advertised: [1, 2, 3], clientSupported: [2, 3]) == .supported(major: 3))
    }

    @Test func failsClosed() {
        #expect(APIVersion.negotiate(advertised: []) == .unsupported)
        #expect(APIVersion.negotiate(advertised: [2, 3]) == .unsupported)
        #expect(APIVersion.negotiate(advertised: [0, -1]) == .unsupported)
    }
}
