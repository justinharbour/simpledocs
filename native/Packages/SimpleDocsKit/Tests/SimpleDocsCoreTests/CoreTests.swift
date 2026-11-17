import Foundation
import Testing
@testable import SimpleDocsCore

@Suite struct EditionTests {
    @Test func editionsAreDistinct() {
        #expect(AppEdition.connectedInstance.requiresInstance)
        #expect(!AppEdition.directProvider.requiresInstance)
        #expect(AppEdition.directProvider.storesRecordsLocallyOnly)
        #expect(!AppEdition.connectedInstance.storesRecordsLocallyOnly)
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

    @Test func connectedEditionIsNotConnected() {
        #expect(AppEdition.connectedInstance.capabilityStatuses.allSatisfy { $0.availability == .notConnected })
    }
}

@Suite struct JobOutcomeTests {
    private func delivery(_ status: DeliveryStatus, channel: Channel = .fax) -> ChannelDelivery {
        ChannelDelivery(id: UUID(), channel: channel, direction: .outbound, counterparty: "x", status: status)
    }

    private func job(_ statuses: [DeliveryStatus]) -> CommunicationJob {
        CommunicationJob(id: UUID(), title: "t", createdAt: .now, deliveries: statuses.map { delivery($0) })
    }

    struct Case: CustomTestStringConvertible, Sendable {
        let statuses: [DeliveryStatus]
        let expected: JobOutcome
        var testDescription: String { "\(statuses.map(\.rawValue)) -> \(expected)" }
    }

    static let table: [Case] = {
        typealias S = DeliveryStatus
        return [
            // Single and uniform
            Case(statuses: [], expected: .draft),
            Case(statuses: [S.draft], expected: .draft),
            Case(statuses: [S.awaitingApproval], expected: .awaitingApproval),
            Case(statuses: [S.queued], expected: .inProgress),
            Case(statuses: [S.inProgress], expected: .inProgress),
            Case(statuses: [S.providerReportedComplete], expected: .providerReportedComplete),
            Case(statuses: [S.failed], expected: .failed),
            Case(statuses: [S.canceled], expected: .canceled),
            Case(statuses: [S.canceled, S.canceled], expected: .canceled),
            Case(statuses: [S.providerReportedComplete, S.providerReportedComplete], expected: .providerReportedComplete),
            // Failed beside something still moving is not settled
            Case(statuses: [S.failed, S.inProgress], expected: .inProgress),
            Case(statuses: [S.failed, S.queued], expected: .inProgress),
            Case(statuses: [S.failed, S.awaitingApproval], expected: .awaitingApproval),
            Case(statuses: [S.failed, S.draft], expected: .failed),
            // Completed beside canceled or unsent is partial, never a clean completion
            Case(statuses: [S.providerReportedComplete, S.canceled], expected: .partial),
            Case(statuses: [S.providerReportedComplete, S.draft], expected: .partial),
            Case(statuses: [S.providerReportedComplete, S.failed], expected: .partial),
            Case(statuses: [S.providerReportedComplete, S.failed, S.canceled], expected: .partial),
            // Completed beside something still moving or pending
            Case(statuses: [S.providerReportedComplete, S.inProgress], expected: .inProgress),
            Case(statuses: [S.providerReportedComplete, S.queued], expected: .inProgress),
            Case(statuses: [S.providerReportedComplete, S.awaitingApproval], expected: .awaitingApproval),
            // Active beats pending approval
            Case(statuses: [S.awaitingApproval, S.inProgress], expected: .inProgress),
            Case(statuses: [S.awaitingApproval, S.queued, S.failed], expected: .inProgress),
            // Canceled and draft without completion or failure
            Case(statuses: [S.canceled, S.draft], expected: .draft),
            Case(statuses: [S.canceled, S.awaitingApproval], expected: .awaitingApproval),
            Case(statuses: [S.canceled, S.inProgress], expected: .inProgress),
            // Failure with canceled
            Case(statuses: [S.failed, S.canceled], expected: .failed),
        ]
    }()

    @Test(arguments: table)
    func outcomePrecedence(_ c: Case) {
        #expect(job(c.statuses).outcome == c.expected)
    }

    /// Checks every combination of statuses (each present or absent), so no mix is left unspecified.
    @Test func invariantsHoldForEveryStatusCombination() {
        let all: [DeliveryStatus] = [.draft, .awaitingApproval, .queued, .inProgress, .providerReportedComplete, .failed, .canceled]
        for mask in 1..<(1 << all.count) {
            let present = all.enumerated().filter { mask & (1 << $0.offset) != 0 }.map(\.element)
            let j = job(present)
            let outcome = j.outcome
            let has = { (s: DeliveryStatus) in present.contains(s) }
            let active = has(.queued) || has(.inProgress)
            let label = "\(present.map(\.rawValue))"

            if active { #expect(outcome == .inProgress, "active must win: \(label)") }
            if !active && has(.awaitingApproval) { #expect(outcome == .awaitingApproval, "\(label)") }
            if outcome == .providerReportedComplete {
                #expect(present.allSatisfy { $0 == .providerReportedComplete }, "clean completion needs all complete: \(label)")
            }
            if outcome == .canceled { #expect(present.allSatisfy { $0 == .canceled }, "\(label)") }
            if outcome == .failed { #expect(has(.failed) && !has(.providerReportedComplete), "\(label)") }
            if outcome == .partial { #expect(has(.providerReportedComplete), "\(label)") }
            if has(.failed) && !active && !has(.awaitingApproval) && !has(.providerReportedComplete) {
                #expect(outcome == .failed, "a failure must not be hidden: \(label)")
            }
            if has(.providerReportedComplete) && !active && !has(.awaitingApproval) && present.count > 1 {
                #expect(outcome == .partial, "completed work must not look clean or be hidden: \(label)")
            }

            let note = j.outcomeNote ?? ""
            if has(.providerReportedComplete) && outcome != .providerReportedComplete && outcome != .partial {
                #expect(note.contains("reported complete"), "settled completion must stay visible: \(label)")
            }
            if has(.failed) && outcome != .failed && outcome != .partial {
                #expect(note.contains("failed"), "settled failure must stay visible: \(label)")
            }
            if has(.canceled) && (outcome == .inProgress || outcome == .awaitingApproval || outcome == .draft) {
                #expect(note.contains("canceled"), "\(label)")
            }
        }
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

    @Test func settledResultsStayVisibleBesideActiveOnes() {
        let note = job([.failed, .providerReportedComplete, .inProgress]).outcomeNote
        #expect(note?.contains("1 failed") == true)
        #expect(note?.contains("1 reported complete by the provider") == true)
        #expect(job([.providerReportedComplete]).outcomeNote?.contains("Already settled") != true)
        #expect(job([.draft]).outcomeNote == nil)
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
