/// A credential's presence does not prove authorization or feature support.
public enum DirectFeature: CaseIterable, Sendable {
    case outboundFax, inboundFax, outboundVoice, inboundVoice, voicemail, outboundMail
}

public enum DirectEligibility: Equatable, Sendable {
    case unavailable(reason: Reason)

    public enum Reason: Equatable, Sendable {
        case providerIntegrationUnverified
        case inboundCaptureUnverified
        case voiceIntegrationUnverified
    }
}

/// This foundation deliberately has no eligible state. Future implementations must
/// enforce their own verified authorization and delivery safeguards at the action boundary.
public func eligibility(for feature: DirectFeature) -> DirectEligibility {
    switch feature {
    case .outboundFax, .outboundMail: return .unavailable(reason: .providerIntegrationUnverified)
    case .inboundFax, .inboundVoice, .voicemail: return .unavailable(reason: .inboundCaptureUnverified)
    case .outboundVoice: return .unavailable(reason: .voiceIntegrationUnverified)
    }
}
