import Foundation

/// Which synthetic state the interface is showing. These exist so every screen state can be
/// reviewed without a backend or provider. They never come from real data.
public enum SyntheticScenario: String, CaseIterable, Identifiable, Sendable {
    case empty
    case populated
    case loading
    case failure

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .empty: "Empty"
        case .populated: "Sample records"
        case .loading: "Loading"
        case .failure: "Error"
        }
    }
}

public enum LoadState<Value: Sendable>: Sendable {
    case loading
    case loaded(Value)
    case failed(message: String)
}

public enum SyntheticData {
    private static func id(_ n: Int) -> UUID {
        UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", n))!
    }

    /// Fixed reference time so snapshots and tests are stable.
    public static let referenceDate = Date(timeIntervalSince1970: 1_800_000_000)

    /// Names, numbers and addresses are fictional. 555-01xx numbers are reserved for fiction.
    public static let jobs: [CommunicationJob] = [
        CommunicationJob(
            id: id(1),
            title: "Sample lease addendum",
            createdAt: referenceDate.addingTimeInterval(-3_600),
            deliveries: [
                ChannelDelivery(
                    id: id(11), channel: .fax, direction: .outbound,
                    counterparty: "+1 555 0100 (sample)",
                    status: .providerReportedComplete,
                    rawProviderStatus: "delivered (sample)"
                ),
                ChannelDelivery(
                    id: id(12), channel: .mail, direction: .outbound,
                    counterparty: "Sample Recipient, 1 Example Way",
                    status: .failed,
                    rawProviderStatus: "error (sample)",
                    proof: .approved(digest: "sample-1a2b3c"),
                    note: "Sample failure. Nothing is resent automatically."
                ),
            ]
        ),
        CommunicationJob(
            id: id(2),
            title: "Sample statement",
            createdAt: referenceDate.addingTimeInterval(-86_400),
            deliveries: [
                ChannelDelivery(
                    id: id(21), channel: .mail, direction: .outbound,
                    counterparty: "Sample Recipient, 2 Example Way",
                    status: .awaitingApproval,
                    proof: .readyForApproval(digest: "sample-4d5e6f")
                ),
            ]
        ),
        CommunicationJob(
            id: id(3),
            title: "Sample inbound fax",
            createdAt: referenceDate.addingTimeInterval(-172_800),
            deliveries: [
                ChannelDelivery(
                    id: id(31), channel: .fax, direction: .inbound,
                    counterparty: "+1 555 0101 (sample)",
                    status: .providerReportedComplete,
                    rawProviderStatus: "received (sample)"
                ),
            ]
        ),
        CommunicationJob(
            id: id(4),
            title: "Sample voicemail",
            createdAt: referenceDate.addingTimeInterval(-259_200),
            deliveries: [
                ChannelDelivery(
                    id: id(41), channel: .voicemail, direction: .inbound,
                    counterparty: "+1 555 0102 (sample)",
                    status: .providerReportedComplete,
                    rawProviderStatus: "recorded (sample)"
                ),
            ]
        ),
        CommunicationJob(
            id: id(5),
            title: "Sample notice",
            createdAt: referenceDate.addingTimeInterval(-345_600),
            deliveries: [
                ChannelDelivery(
                    id: id(51), channel: .mail, direction: .outbound,
                    counterparty: "Sample Recipient, 3 Example Way",
                    status: .draft,
                    proof: .invalidated(reason: "Contents changed after the proof was approved. Generate a new proof.")
                ),
            ]
        ),
    ]

    public static func jobs(for scenario: SyntheticScenario) -> LoadState<[CommunicationJob]> {
        switch scenario {
        case .empty: .loaded([])
        case .populated: .loaded(jobs)
        case .loading: .loading
        case .failure: .failed(message: "Sample error. Records could not be loaded.")
        }
    }
}
