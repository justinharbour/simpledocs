import SimpleDocsCore
import SwiftUI

public struct WorkspaceView: View {
    @Bindable private var model: WorkspaceModel

    public init(model: WorkspaceModel) {
        self.model = model
    }

    public var body: some View {
        NavigationSplitView {
            List(model.sections, selection: $model.selection) { section in
                NavigationLink(value: section) {
                    Label(section.title, systemImage: section.systemImage)
                }
            }
            .navigationTitle("simpledocs")
            #if os(macOS)
            .navigationSplitViewColumnWidth(min: 180, ideal: 220)
            #endif
        } detail: {
            NavigationStack {
                detail
            }
        }
        .toolbar {
            ToolbarItem {
                scenarioMenu
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        switch model.selection ?? .records {
        case .records:
            RecordsView(model: model)
        case .instance:
            InstanceSetupView()
        case .capabilities:
            CapabilitiesView(edition: model.edition)
        case .about:
            EditionView(edition: model.edition)
        }
    }

    private var scenarioMenu: some View {
        Menu {
            Picker("Sample state", selection: $model.scenario) {
                ForEach(SyntheticScenario.allCases) { scenario in
                    Text(scenario.title).tag(scenario)
                }
            }
        } label: {
            Label("Sample state", systemImage: "testtube.2")
        }
        .help("Choose which synthetic state to preview")
        .accessibilityHint("Changes the synthetic sample data shown. No real data is loaded.")
    }
}

struct PreviewNotice: View {
    let edition: AppEdition

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text("Preview with sample data")
                    .font(.headline)
                Text("\(edition.displayName). Nothing here is connected to a backend or provider, and nothing can be sent.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
        }
        .accessibilityElement(children: .combine)
    }
}

struct RecordsView: View {
    let model: WorkspaceModel

    var body: some View {
        Group {
            switch model.jobs {
            case .loading:
                ProgressView("Loading sample records")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                ContentUnavailableView {
                    Label("Records unavailable", systemImage: "exclamationmark.octagon")
                } description: {
                    Text(message)
                } actions: {
                    Button("Show sample records") { model.scenario = .populated }
                }
            case .loaded(let jobs) where jobs.isEmpty:
                ContentUnavailableView(
                    "No records",
                    systemImage: "tray",
                    description: Text("Sent and received faxes, calls, voicemail and mail will appear here once an account is connected.")
                )
            case .loaded(let jobs):
                List {
                    Section {
                        PreviewNotice(edition: model.edition)
                    }
                    Section("Sample records") {
                        ForEach(jobs) { job in
                            NavigationLink {
                                JobDetailView(job: job)
                            } label: {
                                JobRow(job: job)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Records")
    }
}

struct JobRow: View {
    let job: CommunicationJob

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(job.title)
                .font(.headline)
            HStack(spacing: 8) {
                ForEach(job.channels) { channel in
                    Text(channel.title)
                }
                Text(job.outcome.title)
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Accessibility.label(for: job))
    }
}

struct JobDetailView: View {
    let job: CommunicationJob

    var body: some View {
        List {
            Section {
                LabeledContent("Overall", value: job.outcome.title)
                LabeledContent("Created") {
                    Text(job.createdAt, format: .dateTime.year().month().day().hour().minute())
                }
                if let explanation = job.outcomeNote {
                    Text(explanation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Section("Deliveries") {
                ForEach(job.deliveries) { delivery in
                    DeliveryRow(delivery: delivery)
                }
            }
        }
        .navigationTitle(job.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

struct DeliveryRow: View {
    let delivery: ChannelDelivery

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(delivery.channel.title), \(delivery.direction.title.lowercased())")
                .font(.headline)
            Text(delivery.counterparty)
            Text(delivery.status.title)
            if let raw = delivery.rawProviderStatus {
                Text("Provider status: \(raw)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let title = delivery.proof.title {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                if let detail = delivery.proof.detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            if let note = delivery.note {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct CapabilitiesView: View {
    let edition: AppEdition

    var body: some View {
        List {
            Section {
                ForEach(edition.capabilityStatuses) { status in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(status.capability.title)
                            Spacer()
                            Text(status.availability.title)
                                .foregroundStyle(.secondary)
                        }
                        Text(status.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } footer: {
                Text("No capability is available in this build. Availability depends on the connection and on provider account capabilities that have not been verified.")
            }
        }
        .navigationTitle("Capabilities")
    }
}

struct EditionView: View {
    let edition: AppEdition

    var body: some View {
        List {
            Section {
                Text(edition.displayName).font(.headline)
                Text(edition.summary)
            }
            Section("Current limitations") {
                ForEach(edition.limitations, id: \.self) { limitation in
                    Text(limitation)
                }
            }
            Section {
                Text("Credentials are never stored in source, app bundles or logs. This build has no credential entry and makes no network requests to an instance or provider.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("About this edition")
    }
}
