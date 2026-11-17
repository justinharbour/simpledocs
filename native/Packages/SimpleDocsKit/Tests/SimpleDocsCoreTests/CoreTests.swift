import Foundation
import Testing
@testable import SimpleDocsCore

@Suite struct EditionTests {
    @Test func editionsAreDistinct() {
        #expect(AppEdition.ownerBackend.requiresOwnerBackend)
        #expect(!AppEdition.directProvider.requiresOwnerBackend)
        #expect(AppEdition.directProvider.storesRecordsLocallyOnly)
        #expect(!AppEdition.ownerBackend.storesRecordsLocallyOnly)
    }

    @Test func everyEditionStatesLimitations() {
        for edition in AppEdition.allCases {
            #expect(!edition.limitations.isEmpty)
        }
    }

    @Test func directEditionStatesNoUnattendedGuarantee() {
        let text = AppEdition.directProvider.limitations.joined(separator: " ")
        #expect(text.contains("webhook"))
        #expect(text.contains("not guaranteed"))
    }

    @Test func noCapabilityIsAvailableInThisBuild() {
        for edition in AppEdition.allCases {
            let statuses = edition.capabilityStatuses
            #expect(statuses.count == Capability.allCases.count)
            #expect(statuses.allSatisfy { !$0.detail.isEmpty })
        }
    }

    @Test func ownerEditionIsNotConnected() {
        #expect(AppEdition.ownerBackend.capabilityStatuses.allSatisfy { $0.availability == .notConnected })
    }
}

@Suite struct JobOutcomeTests {
    private func delivery(_ status: DeliveryStatus, channel: Channel = .fax) -> ChannelDelivery {
        ChannelDelivery(id: UUID(), channel: channel, direction: .outbound, counterparty: "x", status: status)
    }

    private func job(_ statuses: [DeliveryStatus]) -> CommunicationJob {
        CommunicationJob(id: UUID(), title: "t", createdAt: .now, deliveries: statuses.map { delivery($0) })
    }

    @Test func partialSuccessIsExplicit() {
        let outcome = job([.providerReportedComplete, .failed]).outcome
        #expect(outcome == .partial)
        #expect(outcome.explanation?.contains("never resent") == true)
    }

    @Test func completionIsNotDeliveryConfirmation() {
        let outcome = job([.providerReportedComplete]).outcome
        #expect(outcome == .providerReportedComplete)
        #expect(outcome.title.localizedCaseInsensitiveContains("provider"))
        #expect(outcome.explanation?.contains("not confirmation of delivery") == true)
    }

    @Test func outcomes() {
        #expect(job([]).outcome == .draft)
        #expect(job([.failed]).outcome == .failed)
        #expect(job([.queued, .providerReportedComplete]).outcome == .inProgress)
        #expect(job([.awaitingApproval]).outcome == .awaitingApproval)
        #expect(job([.canceled, .canceled]).outcome == .canceled)
    }

    @Test func channelsAreDeduplicatedInOrder() {
        let j = CommunicationJob(
            id: UUID(), title: "t", createdAt: .now,
            deliveries: [delivery(.draft, channel: .mail), delivery(.draft, channel: .fax), delivery(.draft, channel: .mail)]
        )
        #expect(j.channels == [.mail, .fax])
    }
}

@Suite struct SyntheticDataTests {
    @Test func idsAreUnique() {
        let ids = SyntheticData.jobs.flatMap { [$0.id] + $0.deliveries.map(\.id) }
        #expect(Set(ids).count == ids.count)
    }

    @Test func fixturesAreMarkedSynthetic() {
        for job in SyntheticData.jobs {
            #expect(job.title.contains("Sample"))
            for delivery in job.deliveries where delivery.channel != .mail {
                #expect(delivery.counterparty.contains("555 01"))
            }
        }
    }

    @Test func fixturesCoverPartialAndApprovalStates() {
        let outcomes = SyntheticData.jobs.map(\.outcome)
        #expect(outcomes.contains(.partial))
        #expect(outcomes.contains(.awaitingApproval))
    }

    @Test func scenarios() {
        guard case .loaded(let empty) = SyntheticData.jobs(for: .empty) else { Issue.record("empty"); return }
        #expect(empty.isEmpty)
        guard case .loaded(let jobs) = SyntheticData.jobs(for: .populated) else { Issue.record("populated"); return }
        #expect(jobs.count == SyntheticData.jobs.count)
        guard case .loading = SyntheticData.jobs(for: .loading) else { Issue.record("loading"); return }
        guard case .failed = SyntheticData.jobs(for: .failure) else { Issue.record("failure"); return }
    }
}
