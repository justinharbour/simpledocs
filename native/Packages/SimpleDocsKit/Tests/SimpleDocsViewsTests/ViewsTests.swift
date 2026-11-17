import Foundation
import SimpleDocsCore
import SwiftUI
import Testing
@testable import SimpleDocsViews

@MainActor
@Suite struct WorkspaceModelTests {
    @Test func jobsFollowScenario() {
        let model = WorkspaceModel(edition: .directProvider, scenario: .empty)
        guard case .loaded(let empty) = model.jobs else { Issue.record("expected loaded"); return }
        #expect(empty.isEmpty)
        model.scenario = .failure
        guard case .failed = model.jobs else { Issue.record("expected failed"); return }
    }

    @Test func viewsBuildForEveryEditionAndScenario() {
        for edition in AppEdition.allCases {
            for scenario in SyntheticScenario.allCases {
                let model = WorkspaceModel(edition: edition, scenario: scenario)
                _ = WorkspaceView(model: model).body
            }
        }
    }
}

@Suite struct AccessibilityLabelTests {
    @Test func jobLabelNamesChannelsAndOutcome() {
        let job = SyntheticData.jobs[0]
        let label = Accessibility.label(for: job)
        #expect(label.contains("Fax and Mail"))
        #expect(label.contains("Partly complete"))
    }

    @Test func deliveryLabelIncludesProofState() {
        let delivery = SyntheticData.jobs[1].deliveries[0]
        let label = Accessibility.label(for: delivery)
        #expect(label.contains("Awaiting approval"))
        #expect(label.contains("approval required"))
    }
}
