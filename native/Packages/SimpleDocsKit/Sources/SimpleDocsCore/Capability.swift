import Foundation

public enum Channel: String, CaseIterable, Identifiable, Sendable, Codable {
    case fax
    case voice
    case voicemail
    case mail

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .fax: "Fax"
        case .voice: "Call"
        case .voicemail: "Voicemail"
        case .mail: "Mail"
        }
    }
}

public enum Direction: String, Sendable, Codable {
    case inbound
    case outbound

    public var title: String {
        switch self {
        case .inbound: "Inbound"
        case .outbound: "Outbound"
        }
    }
}

public enum Capability: String, CaseIterable, Identifiable, Sendable {
    case outboundFax
    case inboundFax
    case outboundVoice
    case inboundVoice
    case voicemail
    case outboundMail

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .outboundFax: "Send fax"
        case .inboundFax: "Receive fax"
        case .outboundVoice: "Place calls"
        case .inboundVoice: "Receive calls"
        case .voicemail: "Voicemail"
        case .outboundMail: "Send paper mail"
        }
    }
}

/// No case here means "available". Nothing in this build talks to a backend or provider,
/// so a capability can only be unavailable until a later change verifies it.
public enum CapabilityAvailability: Sendable, Equatable {
    case notConnected
    case notConfigured
    case unverified
    case unsupported

    public var title: String {
        switch self {
        case .notConnected: "Not connected"
        case .notConfigured: "Not configured"
        case .unverified: "Not verified"
        case .unsupported: "Not supported"
        }
    }
}

public struct CapabilityStatus: Identifiable, Sendable, Equatable {
    public let capability: Capability
    public let availability: CapabilityAvailability
    public let detail: String

    public var id: Capability.ID { capability.id }
}

extension AppEdition {
    public var capabilityStatuses: [CapabilityStatus] {
        Capability.allCases.map { capability in
            switch self {
            case .ownerBackend:
                CapabilityStatus(
                    capability: capability,
                    availability: .notConnected,
                    detail: "Feature controls are enforced by the backend, which is not connected."
                )
            case .directProvider:
                directStatus(for: capability)
            }
        }
    }

    private func directStatus(for capability: Capability) -> CapabilityStatus {
        switch capability {
        case .outboundFax:
            CapabilityStatus(capability: capability, availability: .notConfigured,
                             detail: "Needs Telnyx credentials. Provider behavior is not verified.")
        case .outboundMail:
            CapabilityStatus(capability: capability, availability: .notConfigured,
                             detail: "Needs PostGrid credentials. A verified provider proof and your approval are required before any send.")
        case .outboundVoice:
            CapabilityStatus(capability: capability, availability: .unverified,
                             detail: "Native WebRTC support and licensing are not verified.")
        case .inboundFax, .inboundVoice, .voicemail:
            CapabilityStatus(capability: capability, availability: .unverified,
                             detail: "Needs a provider history API or a separately hosted webhook service. Unattended capture is not guaranteed.")
        }
    }
}
