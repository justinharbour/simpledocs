import Foundation

/// Result of checking the *format* of an instance address. It never contacts the address,
/// so a valid format says nothing about whether a simpledocs instance exists there.
public enum InstanceAddressCheck: Equatable, Sendable {
    case empty
    case wellFormed(URL)
    case rejected(reason: String)

    public var message: String {
        switch self {
        case .empty:
            "Enter the address of your instance, for example https://simpledocs.example.com."
        case .wellFormed:
            "The address format looks valid. It has not been contacted, so it is not known to be a simpledocs instance."
        case .rejected(let reason):
            reason
        }
    }

    public var isWellFormed: Bool {
        if case .wellFormed = self { true } else { false }
    }
}

public enum InstanceAddress {
    /// Accepts only an https origin: no credentials, path, query or fragment.
    public static func check(_ input: String) -> InstanceAddressCheck {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .empty }
        guard !trimmed.contains(where: \.isWhitespace) else {
            return .rejected(reason: "The address cannot contain spaces.")
        }
        guard let components = URLComponents(string: trimmed), components.scheme != nil else {
            return .rejected(reason: "Start the address with https://.")
        }
        guard components.scheme?.lowercased() == "https" else {
            return .rejected(reason: "Only https addresses are accepted.")
        }
        guard let host = components.host, !host.isEmpty else {
            return .rejected(reason: "The address needs a host name.")
        }
        guard components.user == nil, components.password == nil else {
            return .rejected(reason: "Do not put a user name or password in the address.")
        }
        guard components.query == nil, components.fragment == nil else {
            return .rejected(reason: "Remove anything after the host name, such as a query or fragment.")
        }
        guard components.path.isEmpty || components.path == "/" else {
            return .rejected(reason: "Enter the host name only, without a path.")
        }
        if let port = components.port, !(1...65_535).contains(port) {
            return .rejected(reason: "The port number is not valid.")
        }
        var normalized = URLComponents()
        normalized.scheme = "https"
        normalized.host = host.lowercased()
        normalized.port = components.port
        guard let url = normalized.url else {
            return .rejected(reason: "The address is not valid.")
        }
        return .wellFormed(url)
    }
}

public enum OnboardingStepStatus: Sendable, Equatable {
    /// The app side is not built yet.
    case notImplemented
    /// Something outside the app does not exist yet, such as published deployment instructions.
    case notPublished
    /// Needs a decision before it can be built.
    case undecided

    public var title: String {
        switch self {
        case .notImplemented: "Not implemented"
        case .notPublished: "Not published"
        case .undecided: "Not decided"
        }
    }
}

public struct OnboardingStep: Identifiable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let detail: String
    public let status: OnboardingStepStatus
}

/// The planned order for linking the app to a person's own instance. None of it works yet.
public enum InstanceOnboarding {
    public static let steps: [OnboardingStep] = [
        OnboardingStep(
            id: "deploy",
            title: "Deploy your own instance",
            detail: "Run simpledocs in your own Cloudflare account. Deployment instructions and a Deploy to Cloudflare button have not been published.",
            status: .notPublished
        ),
        OnboardingStep(
            id: "address",
            title: "Enter your instance address",
            detail: "Only the format is checked on this device. The address is not saved or contacted.",
            status: .notImplemented
        ),
        OnboardingStep(
            id: "compatibility",
            title: "Check the instance",
            detail: "The app will need to confirm that the address is a simpledocs instance with a compatible version.",
            status: .notImplemented
        ),
        OnboardingStep(
            id: "signin",
            title: "Sign in",
            detail: "How people sign in to a self-deployed instance has not been decided. The app will not embed an access token or provider keys.",
            status: .undecided
        ),
        OnboardingStep(
            id: "features",
            title: "Review feature controls",
            detail: "Each instance decides which channels are enabled. The app will show what your instance reports and will not assume anything is available.",
            status: .notImplemented
        ),
    ]
}
