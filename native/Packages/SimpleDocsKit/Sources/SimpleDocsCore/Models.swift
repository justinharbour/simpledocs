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
            "Some channels finished and others failed. Finished channels are never resent automatically."
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

    public var outcome: JobOutcome {
        let statuses = deliveries.map(\.status)
        guard !statuses.isEmpty else { return .draft }
        let completed = statuses.contains(.providerReportedComplete)
        let failed = statuses.contains(.failed)
        if completed && failed { return .partial }
        if failed { return .failed }
        if statuses.contains(.inProgress) || statuses.contains(.queued) { return .inProgress }
        if statuses.contains(.awaitingApproval) { return .awaitingApproval }
        if statuses.allSatisfy({ $0 == .providerReportedComplete }) { return .providerReportedComplete }
        if statuses.allSatisfy({ $0 == .canceled }) { return .canceled }
        return .draft
    }
}
