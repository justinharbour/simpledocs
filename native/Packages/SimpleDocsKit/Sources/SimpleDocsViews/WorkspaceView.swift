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
        ContentUnavailableView(
            "Records unavailable",
            systemImage: "tray",
            description: Text(model.edition.requiresInstance
                ? "This app cannot load communication records yet. Use your instance's web workspace to check available records."
                : "This app cannot load communication records from providers yet.")
        )
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
