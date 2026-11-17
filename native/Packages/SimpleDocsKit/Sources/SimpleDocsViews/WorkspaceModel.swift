import Observation
import SimpleDocsCore
import SwiftUI

@MainActor
@Observable
public final class WorkspaceModel {
    public let edition: AppEdition
    public var scenario: SyntheticScenario
    public var selection: WorkspaceSection? = .records

    public init(edition: AppEdition, scenario: SyntheticScenario = .populated) {
        self.edition = edition
        self.scenario = scenario
    }

    public var jobs: LoadState<[CommunicationJob]> {
        SyntheticData.jobs(for: scenario)
    }

    /// Instance setup only exists for editions that link to a self-deployed instance.
    public var sections: [WorkspaceSection] {
        WorkspaceSection.allCases.filter { $0 != .instance || edition.requiresInstance }
    }
}

public enum WorkspaceSection: String, CaseIterable, Identifiable, Hashable, Sendable {
    case records
    case instance
    case capabilities
    case about

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .records: "Records"
        case .instance: "Your instance"
        case .capabilities: "Capabilities"
        case .about: "About this edition"
        }
    }

    public var systemImage: String {
        switch self {
        case .records: "tray.full"
        case .instance: "externaldrive.connected.to.line.below"
        case .capabilities: "switch.2"
        case .about: "info.circle"
        }
    }
}

enum Accessibility {
    static func label(for delivery: ChannelDelivery) -> String {
        var parts = [
            "\(delivery.channel.title), \(delivery.direction.title.lowercased())",
            delivery.counterparty,
            delivery.status.title,
        ]
        if let proof = delivery.proof.title { parts.append(proof) }
        return parts.joined(separator: ", ")
    }

    static func label(for job: CommunicationJob) -> String {
        let channels = job.channels.map(\.title).joined(separator: " and ")
        return "\(job.title), \(channels), \(job.outcome.title)"
    }
}
