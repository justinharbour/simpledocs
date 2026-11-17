import Foundation
import SimpleDocsConnected

/// Configuration must come from an independent operator-controlled channel, not resource metadata.
/// Constructing it validates syntax, not the provenance of the configured team.
public struct CloudflareTrust: Sendable {
    public let binding: ContextBinding
    public let resource: InstanceOrigin
    public let team: InstanceOrigin

    public init(registry: InstanceRegistry, binding: ContextBinding, configuredTeam: String) throws {
        guard registry.isCurrent(binding), let active = registry.active else { throw DiscoveryError.staleContext }
        guard let team = try? InstanceOrigin.parse(configuredTeam).get(), team.port == nil,
              team.host.hasSuffix(".cloudflareaccess.com"),
              team.host.split(separator: ".").count == 3 else { throw DiscoveryError.invalidMetadata }
        self.binding = binding
        self.resource = active.scope.origin
        self.team = team
    }

    public func validateResourceMetadata(_ data: Data, registry: InstanceRegistry) throws {
        guard registry.isCurrent(binding) else { throw DiscoveryError.staleContext }
        guard data.count <= 65_536 else { throw DiscoveryError.responseTooLarge }
        struct Resource: Decodable {
            let resource: String
            let authorization_servers: [String]
            let protected: Bool?
            let authentication_method: String?
            let authentication_methods: [String]?
        }
        guard let doc = try? JSONDecoder().decode(Resource.self, from: data),
              doc.resource == resource.canonical || doc.resource == resource.canonical + "/",
              doc.authorization_servers == [team.canonical], doc.protected != false else { throw DiscoveryError.invalidMetadata }
        // This is a negative signal only. Unknown or absent method fields do not prove OAuth is enabled.
        if let methods = doc.authentication_methods,
           (methods.isEmpty || methods.allSatisfy({ $0.lowercased() == "cloudflared" })) {
            throw DiscoveryError.oauthNotAdvertised
        }
        if doc.authentication_methods == nil, doc.authentication_method?.lowercased() == "cloudflared" {
            throw DiscoveryError.oauthNotAdvertised
        }
    }

    public func validateIssuerMetadata(_ data: Data, registry: InstanceRegistry) throws -> CloudflareEndpoints {
        guard registry.isCurrent(binding) else { throw DiscoveryError.staleContext }
        guard data.count <= 65_536 else { throw DiscoveryError.responseTooLarge }
        struct Issuer: Decodable {
            let issuer: String
            let authorization_endpoint: String
            let token_endpoint: String
            let registration_endpoint: String
            let response_types_supported: [String]
            let grant_types_supported: [String]
            let code_challenge_methods_supported: [String]
            let token_endpoint_auth_methods_supported: [String]
        }
        guard let doc = try? JSONDecoder().decode(Issuer.self, from: data),
              doc.issuer == team.canonical,
              doc.response_types_supported.contains("code"), doc.grant_types_supported.contains("authorization_code"),
              doc.code_challenge_methods_supported.contains("S256"), doc.token_endpoint_auth_methods_supported.contains("none"),
              doc.authorization_endpoint == team.canonical + "/cdn-cgi/access/oauth/authorization",
              doc.token_endpoint == team.canonical + "/cdn-cgi/access/oauth/token",
              doc.registration_endpoint == team.canonical + "/cdn-cgi/access/oauth/registration",
              let auth = URL(string: doc.authorization_endpoint), let token = URL(string: doc.token_endpoint),
              let registration = URL(string: doc.registration_endpoint) else { throw DiscoveryError.invalidMetadata }
        return CloudflareEndpoints(authorization: auth, token: token, registration: registration, binding: binding)
    }
}

public struct CloudflareEndpoints: Sendable {
    public let authorization: URL
    public let token: URL
    public let registration: URL
    public let binding: ContextBinding
}
