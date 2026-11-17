import Foundation
import SimpleDocsConnected

/// The caller must display both canonical values and obtain an explicit
/// confirmation before constructing an IssuerConfirmation.
@MainActor public struct SignInPreparation {
    public let resource: String
    public let issuer: String
    private let binding: ContextBinding
    private let configuredIssuer: String

    public init(registry: InstanceRegistry, binding: ContextBinding, configuredIssuer: String) throws {
        let trust = try CloudflareTrust(registry: registry, binding: binding, configuredTeam: configuredIssuer)
        self.resource = trust.resource.canonical
        self.issuer = trust.team.canonical
        self.binding = binding
        self.configuredIssuer = configuredIssuer
    }

    public func confirm(resource: String, issuer: String, registry: InstanceRegistry) throws -> IssuerConfirmation {
        try IssuerConfirmation(registry: registry, binding: binding, configuredIssuer: configuredIssuer,
                               confirmedResource: resource, confirmedIssuer: issuer)
    }
}
