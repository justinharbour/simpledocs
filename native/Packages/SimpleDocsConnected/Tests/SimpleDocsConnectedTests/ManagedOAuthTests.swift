import CryptoKit
import Foundation
import Testing
@testable import SimpleDocsConnected

@MainActor @Suite struct ManagedOAuthTests {
    private func setup() throws -> (InstanceRegistry, ContextBinding) {
        let origin = try InstanceOrigin.parse("https://instance.example.com").get()
        var registry = InstanceRegistry()
        let link = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        let context = try registry.activate(link.linkID)
        return (registry, ContextBinding(context))
    }
    private func transaction(_ registry: InstanceRegistry, _ binding: ContextBinding) throws -> ManagedOAuthTransaction {
        try ManagedOAuthTransaction(registry: registry, binding: binding,
                                    authorizationEndpoint: URL(string: "https://identity.example.com/authorize")!,
                                    tokenEndpoint: URL(string: "https://identity.example.com/token")!,
                                    callback: URL(string: "com.example.simpledocs:/oauth/callback")!, clientID: "public-client")
    }
    private func callback(_ tx: ManagedOAuthTransaction, code: String = "code") throws -> URL {
        let items = try #require(URLComponents(url: tx.authorizationURL, resolvingAgainstBaseURL: false)?.queryItems)
        let state = try #require(items.first { $0.name == "state" }?.value)
        var result = URLComponents(string: "com.example.simpledocs:/oauth/callback")!
        result.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "code", value: code)]
        return try #require(result.url)
    }
    @Test func pkceAndResourceAreBoundToTransaction() throws {
        let (registry, binding) = try setup()
        let tx = try transaction(registry, binding)
        let query = try #require(URLComponents(url: tx.authorizationURL, resolvingAgainstBaseURL: false)?.queryItems)
        let exchange = try tx.consume(callbackURL: callback(tx), registry: registry)
        let challenge = Data(SHA256.hash(data: Data(exchange.verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        #expect(query.first { $0.name == "code_challenge" }?.value == challenge)
        #expect(challenge.prefix(1).allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) })
        #expect(query.first { $0.name == "code_challenge_method" }?.value == "S256")
        #expect(query.first { $0.name == "resource" }?.value == "https://instance.example.com/")
        #expect(exchange.resource == "https://instance.example.com/")
        #expect(throws: OAuthFlowError.alreadyConsumed) { try tx.consume(callbackURL: callback(tx), registry: registry) }
    }
    @Test func rejectsCallbackMixupAndDuplicates() throws {
        let (registry, binding) = try setup()
        let a = try transaction(registry, binding)
        let b = try transaction(registry, binding)
        #expect(throws: OAuthFlowError.invalidCallback) { try a.consume(callbackURL: callback(b), registry: registry) }
        #expect(throws: OAuthFlowError.alreadyConsumed) { try a.consume(callbackURL: callback(a), registry: registry) }
        let c = try transaction(registry, binding)
        let duplicate = URL(string: try callback(c).absoluteString + "&code=second")!
        #expect(throws: OAuthFlowError.invalidCallback) { try c.consume(callbackURL: duplicate, registry: registry) }
    }
    @Test func switchingInstanceInvalidatesCallback() throws {
        var (registry, binding) = try setup()
        let tx = try transaction(registry, binding)
        let origin = try InstanceOrigin.parse("https://other.example.com").get()
        let other = try registry.link(AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical)!)
        try registry.activate(other.linkID)
        #expect(throws: OAuthFlowError.staleContext) { try tx.consume(callbackURL: callback(tx), registry: registry) }
    }
    @Test func rejectsUnsafeEndpointsAndCallbacks() throws {
        let (registry, binding) = try setup()
        #expect(throws: OAuthFlowError.invalidConfiguration) {
            try ManagedOAuthTransaction(registry: registry, binding: binding,
                authorizationEndpoint: URL(string: "http://identity.example.com/authorize")!,
                tokenEndpoint: URL(string: "https://identity.example.com/token")!,
                callback: URL(string: "com.example.simpledocs:/oauth/callback")!, clientID: "client")
        }
    }
}
