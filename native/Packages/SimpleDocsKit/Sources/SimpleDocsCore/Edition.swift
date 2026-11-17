import Foundation

/// The two product editions. The iOS app is always `.ownerBackend`.
public enum AppEdition: String, CaseIterable, Identifiable, Sendable, Codable {
    case ownerBackend
    case directProvider

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .ownerBackend: "Owner (backend-connected)"
        case .directProvider: "Direct-provider"
        }
    }

    public var summary: String {
        switch self {
        case .ownerBackend:
            "Connects to the owner's Cloudflare Worker and uses its records and feature controls."
        case .directProvider:
            "Connects directly to Telnyx and PostGrid with credentials you provide. It does not use the owner's backend."
        }
    }

    public var requiresOwnerBackend: Bool {
        self == .ownerBackend
    }

    public var storesRecordsLocallyOnly: Bool {
        self == .directProvider
    }

    /// Limitations that must stay visible in the interface until each is verified and lifted.
    public var limitations: [String] {
        switch self {
        case .ownerBackend:
            [
                "Sign-in through Cloudflare Access and Entra is not implemented yet; the native flow is still to be verified.",
                "No backend address is configured, so no live records, proofs or feature controls are available.",
            ]
        case .directProvider:
            [
                "Provider access is not implemented yet. Which provider APIs can return history, fax documents, voicemail and tracking is still to be verified.",
                "The app has no always-on webhook receiver. Incoming live calls, unattended event capture and reliable notifications are not guaranteed.",
                "A credential saved on this Mac can be extracted by anyone who controls the device. Use least-privilege provider keys.",
                "Records stay on this Mac and are never uploaded to the owner's backend. Backup, export and deletion are still to be designed.",
            ]
        }
    }
}
