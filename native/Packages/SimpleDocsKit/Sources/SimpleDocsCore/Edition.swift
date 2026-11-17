import Foundation

/// The two product editions. The iOS app is always `.connectedInstance`.
///
/// A connected edition talks to a simpledocs instance that the person running the app has
/// deployed to their own Cloudflare account. No instance address is built into the app.
public enum AppEdition: String, CaseIterable, Identifiable, Sendable, Codable {
    case connectedInstance
    case directProvider

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .connectedInstance: "Connected to your instance"
        case .directProvider: "Direct-provider"
        }
    }

    public var summary: String {
        switch self {
        case .connectedInstance:
            "Connects to a simpledocs instance that you deploy to your own Cloudflare account, and uses that instance's records and feature controls."
        case .directProvider:
            "Connects directly to Telnyx and PostGrid with credentials you provide. It does not use a simpledocs instance."
        }
    }

    public var requiresInstance: Bool {
        self == .connectedInstance
    }

    public var storesRecordsLocallyOnly: Bool {
        self == .directProvider
    }

    /// Limitations that must stay visible in the interface until each is verified and lifted.
    public var limitations: [String] {
        switch self {
        case .connectedInstance:
            [
                "Connecting to an instance is not implemented yet. No instance address is saved and nothing is contacted.",
                "Sign-in for self-deployed instances is not decided or implemented, so no records, proofs or feature controls are available.",
                "Deployment instructions for your own instance are not published yet.",
            ]
        case .directProvider:
            [
                "Provider access is not implemented yet. Which provider APIs can return history, fax documents, voicemail and tracking is still to be verified.",
                "The app has no always-on webhook receiver. Incoming live calls, unattended event capture and reliable notifications are not guaranteed.",
                "A credential saved on this Mac can be extracted by anyone who controls the device. Use least-privilege provider keys.",
                "Records stay on this Mac and are never uploaded to a simpledocs instance. Backup, export and deletion are still to be designed.",
            ]
        }
    }
}
