import Foundation

/// Provider-independent status. The provider's own wording lives in `ChannelDelivery.rawProviderStatus`.
public enum DeliveryStatus: String, Sendable, Codable {
    case draft
    case awaitingApproval
    case queued
    case inProgress
    /// The provider says it finished. This is not proof that a person received anything.
    case providerReportedComplete
    case failed
    case canceled

    public var title: String {
        switch self {
        case .draft: "Draft"
        case .awaitingApproval: "Awaiting approval"
        case .queued: "Queued"
        case .inProgress: "In progress"
        case .providerReportedComplete: "Provider reports complete"
        case .failed: "Failed"
        case .canceled: "Canceled"
        }
    }
}

public enum ProofApproval: Hashable, Sendable {
    case notApplicable
    case proofPending
    case readyForApproval(digest: String)
    case approved(digest: String)
    case invalidated(reason: String)

    public var title: String? {
        switch self {
        case .notApplicable: nil
        case .proofPending: "Proof pending"
        case .readyForApproval: "Proof ready, approval required"
        case .approved: "Approved"
        case .invalidated: "Approval invalidated"
        }
    }

    public var detail: String? {
        switch self {
        case .notApplicable, .proofPending: nil
        case .readyForApproval(let digest): "Proof digest \(digest)"
        case .approved(let digest): "Matches proof digest \(digest)"
        case .invalidated(let reason): reason
        }
    }
}

public struct ChannelDelivery: Identifiable, Hashable, Sendable {
    public let id: UUID
    public let channel: Channel
    public let direction: Direction
    public let counterparty: String
    public let status: DeliveryStatus
    public let rawProviderStatus: String?
    public let proof: ProofApproval
    public let note: String?

    public init(
        id: UUID,
        channel: Channel,
        direction: Direction,
        counterparty: String,
        status: DeliveryStatus,
        rawProviderStatus: String? = nil,
        proof: ProofApproval = .notApplicable,
        note: String? = nil
    ) {
        self.id = id
        self.channel = channel
        self.direction = direction
        self.counterparty = counterparty
        self.status = status
        self.rawProviderStatus = rawProviderStatus
        self.proof = proof
        self.note = note
    }
}

public enum JobOutcome: Sendable, Equatable {
    case draft
    case awaitingApproval
    case inProgress
    case providerReportedComplete
    case partial
    case failed
    case canceled

    public var title: String {
        switch self {
        case .draft: "Draft"
        case .awaitingApproval: "Awaiting approval"
        case .inProgress: "In progress"
        case .providerReportedComplete: "Provider reports complete"
        case .partial: "Partly complete"
        case .failed: "Failed"
        case .canceled: "Canceled"
        }
    }

    public var explanation: String? {
        switch self {
        case .partial:
            "Some channels finished and others failed, were canceled or have not been sent. Finished channels are never resent automatically."
        case .providerReportedComplete:
            "Completion is as reported by the provider and is not confirmation of delivery."
        default:
            nil
        }
    }
}

public struct CommunicationJob: Identifiable, Hashable, Sendable {
    public let id: UUID
    public let title: String
    public let createdAt: Date
    public let deliveries: [ChannelDelivery]

    public init(id: UUID, title: String, createdAt: Date, deliveries: [ChannelDelivery]) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.deliveries = deliveries
    }

    public var channels: [Channel] {
        var seen: [Channel] = []
        for delivery in deliveries where !seen.contains(delivery.channel) {
            seen.append(delivery.channel)
        }
        return seen
    }

    /// Job-level outcome from the per-delivery statuses. Precedence, highest first:
    ///
    /// 1. Anything queued or in progress: the job is still moving, so it is never reported as settled.
    /// 2. Anything awaiting approval: the next step is the person's, and nothing more is sent without it.
    /// 3. With nothing active or awaiting approval:
    ///    - an unsent draft next to a finished delivery is `.partial`, so completed work is not hidden;
    ///    - finished next to failed or canceled is `.partial`;
    ///    - a failure with no finished delivery is `.failed`, even beside canceled or draft deliveries;
    ///    - otherwise all finished, all canceled, or draft.
    ///
    /// Results already settled alongside an active or pending delivery are surfaced by `outcomeNote`.
    public var outcome: JobOutcome {
        let counts = statusCounts
        guard counts.total > 0 else { return .draft }
        if counts.active > 0 { return .inProgress }
        if counts.awaitingApproval > 0 { return .awaitingApproval }
        if counts.draft > 0 {
            if counts.completed > 0 { return .partial }
            if counts.failed > 0 { return .failed }
            return .draft
        }
        if counts.completed > 0 {
            return counts.failed > 0 || counts.canceled > 0 ? .partial : .providerReportedComplete
        }
        if counts.failed > 0 { return .failed }
        return .canceled
    }

    /// Explains the outcome and never lets a settled result disappear behind an active or pending one.
    public var outcomeNote: String? {
        let counts = statusCounts
        var parts: [String] = []
        if let explanation = outcome.explanation { parts.append(explanation) }
        let showsSettled: Bool
        switch outcome {
        case .inProgress, .awaitingApproval, .draft: showsSettled = true
        default: showsSettled = false
        }
        if showsSettled {
            var settled: [String] = []
            if counts.completed > 0 { settled.append("\(counts.completed) reported complete by the provider") }
            if counts.failed > 0 { settled.append("\(counts.failed) failed") }
            if counts.canceled > 0 { settled.append("\(counts.canceled) canceled") }
            if !settled.isEmpty {
                parts.append("Already settled: \(settled.joined(separator: ", ")). Settled channels are never resent automatically.")
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    private struct StatusCounts {
        var total = 0, draft = 0, awaitingApproval = 0, active = 0
        var completed = 0, failed = 0, canceled = 0
    }

    private var statusCounts: StatusCounts {
        var counts = StatusCounts()
        for delivery in deliveries {
            counts.total += 1
            switch delivery.status {
            case .draft: counts.draft += 1
            case .awaitingApproval: counts.awaitingApproval += 1
            case .queued, .inProgress: counts.active += 1
            case .providerReportedComplete: counts.completed += 1
            case .failed: counts.failed += 1
            case .canceled: counts.canceled += 1
            }
        }
        return counts
    }
}
