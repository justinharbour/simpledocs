import SimpleDocsConnected
import SimpleDocsOAuth
import SwiftUI

struct RecordsView: View {
    let model: RecordsModel
    let session: ConnectedModel
    @Binding var opening: String?
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Records")
                .navigationDestination(for: String.self) { id in
                    TransmissionView(model: TransmissionModel(session: session, id: id), onChange: { Task { await model.load(quiet: true) } })
                }
                .toolbar {
                    ToolbarItem { Button { Task { await model.load() } } label: { Label("Refresh", systemImage: "arrow.clockwise") } }
                }
        }
        .task { await model.load() }
        .task(id: model.hasActive) { await model.watch() }
        .onChange(of: opening) { _, id in
            if let id { path = [id]; opening = nil }
        }
        .onAppear { if let id = opening { path = [id]; opening = nil } }
    }

    @ViewBuilder private var content: some View {
        if model.records.isEmpty, let message = model.phase.error {
            ErrorBanner(message: message) { Task { await model.load() } }.padding()
        } else if model.records.isEmpty && model.phase != .loaded {
            ProgressView("Loading records…").frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.records.isEmpty {
            ContentUnavailableView("No records yet", systemImage: "tray",
                                   description: Text("Faxes and letters you send, received faxes and voicemails show up here. Choose Send to start."))
        } else {
            list
        }
    }

    private var list: some View {
        List {
            if let message = model.phase.error { ErrorBanner(message: message) { Task { await model.load() } }.listRowSeparator(.hidden) }
            ForEach(model.records) { record in
                if record.type == .transmission {
                    NavigationLink(value: record.id) { RecordRow(record: record) }
                } else {
                    RecordRow(record: record)
                }
            }
        }
        .refreshable { await model.load() }
    }
}

struct RecordRow: View {
    let record: RecordItem

    private var symbol: String {
        switch record.type {
        case .transmission: "paperplane"
        case .inboundFax: "arrow.down.doc"
        case .recording: "voicemail"
        case .other: "doc"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).foregroundStyle(.secondary).frame(width: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(record.title).font(.headline).lineLimit(1)
                    Spacer()
                    if let date = record.date { Text(date.short).font(.caption).foregroundStyle(.secondary) }
                }
                ForEach(record.channels, id: \.self) { StatusBadge(channel: $0.channel, status: $0.status) }
                if let number = record.envelopeNumber { Text("Envelope \(number)").font(.caption).foregroundStyle(.secondary) }
                if let pages = record.pageCount {
                    Text("\(pages) \(pages == 1 ? "page" : "pages")").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct TransmissionView: View {
    @State var model: TransmissionModel
    var onChange: () -> Void = {}
    @State private var mode = MailMode.test

    var body: some View {
        Group {
            if let detail = model.detail {
                List {
                    Section {
                        if let number = detail.envelopeNumber { LabeledContent("Envelope", value: number) }
                        LabeledContent("Pages", value: "\(detail.pageCount)")
                        if let date = WorkerDate.parse(detail.createdAt) { LabeledContent("Created", value: date.formatted(date: .abbreviated, time: .shortened)) }
                        if let file = model.document() { DocumentRow(file: file) }
                    }
                    if let documents = detail.documents, !documents.isEmpty {
                        Section("Document order") {
                            ForEach(documents) { document in
                                LabeledContent(document.name, value: document.number)
                            }
                        }
                    }
                    ForEach(detail.deliveries) { delivery in deliverySection(delivery) }
                }
            } else if let message = model.phase.error {
                ErrorBanner(message: message) { Task { await model.load() } }.padding()
            } else {
                ProgressView("Loading…")
            }
        }
        .navigationTitle(model.detail?.title ?? "Record")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task { await model.watch() }
        .refreshable { await model.load() }
    }

    @ViewBuilder private func deliverySection(_ delivery: DeliveryDetail) -> some View {
        Section {
            StatusBadge(channel: delivery.channel, status: delivery.status)
            if let note = DeliveryStatus.note(channel: delivery.channel, status: delivery.status, needsApproval: delivery.needsApproval) {
                Text(note).font(.footnote).foregroundStyle(.secondary)
            }
            if let error = delivery.error { Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.red) }
            if let provider = delivery.providerStatus, !provider.isEmpty {
                LabeledContent("Provider reported", value: provider)
            }
            if delivery.needsApproval {
                if delivery.channel == "fax" { faxApproval(delivery) }
                else if delivery.channel == "mail" { approval(delivery) }
            }
            if delivery.channel == "email" && (delivery.needsApproval || delivery.status == "unknown") { emailApproval(delivery) }
            ForEach(Array(delivery.timeline.enumerated()), id: \.offset) { _, step in
                HStack(alignment: .firstTextBaseline) {
                    Text(DeliveryStatus.label(step.status)).font(.callout)
                    if let detail = step.detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    if let date = WorkerDate.parse(step.at) { Text(date.short).font(.caption).foregroundStyle(.secondary) }
                }
                .accessibilityElement(children: .combine)
            }
            if let cover = model.cover(delivery) { DocumentRow(file: cover) }
        } header: {
            Text("\(DeliveryStatus.channelLabel(delivery.channel)) · \(delivery.channel == "fax" ? PhoneNumber.display(delivery.recipient) : delivery.recipient)")
        }
    }

    @ViewBuilder private func emailApproval(_ delivery: DeliveryDetail) -> some View {
        if let shown = model.emailReview, shown.review.email == delivery.recipient {
            VStack(alignment: .leading, spacing: 10) {
                Text("Review this secure email invitation").font(.headline)
                LabeledContent("Recipient", value: shown.review.email)
                LabeledContent("Phone verification", value: shown.review.pinChannel == "none" ? "None" : "\(shown.review.pinChannel) · \(shown.review.phone ?? "")")
                Text("The recipient receives a seven-day portal invitation. Acceptance is not delivery confirmation. The portal is not end-to-end encrypted.").font(.footnote)
                Text("PDF SHA-256: \(shown.review.pdfSha256)").font(.caption).textSelection(.enabled)
                PDFKitView(url: shown.url).frame(minHeight: 400)
                HStack {
                    Button("Cancel") { model.cancelEmailReview() }.disabled(model.approvingID != nil)
                    Spacer()
                    Button("Approve and send email") { Task { await model.approveEmail(delivery); onChange() } }
                        .buttonStyle(.borderedProminent).disabled(model.approvingID != nil)
                }
            }
        } else {
            Button("Review secure email") { Task { await model.reviewEmail(delivery) } }.disabled(model.approvingID != nil)
        }
        if let error = model.approvalError { Text(error).font(.footnote).foregroundStyle(.orange) }
    }

    @ViewBuilder private func faxApproval(_ delivery: DeliveryDetail) -> some View {
        if let shown = model.faxReview, shown.deliveryID == delivery.id {
            VStack(alignment: .leading, spacing: 10) {
                Text("Review this exact fax packet").font(.headline)
                LabeledContent("From", value: shown.review.from)
                LabeledContent("To", value: shown.review.recipient)
                Text("Packet SHA-256: \(shown.review.packetSha256)").font(.caption).textSelection(.enabled)
                Text("Pricing is unavailable from this instance. Approval queues this fax and may incur charges.").font(.footnote)
                PDFKitView(url: shown.url).frame(minHeight: 400)
                HStack {
                    Button("Cancel") { model.cancelFaxReview() }.disabled(model.approvingID != nil)
                    Spacer()
                    Button("Approve and queue fax") { Task { await model.approveFax(delivery); onChange() } }
                        .buttonStyle(.borderedProminent).disabled(model.approvingID != nil)
                }
            }
        } else {
            Button("Review fax packet") { Task { await model.reviewFax(delivery) } }
                .disabled(model.approvingID != nil)
        }
        if let error = model.approvalError { Text(error).font(.footnote).foregroundStyle(.orange) }
    }

    @ViewBuilder private func approval(_ delivery: DeliveryDetail) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let shown = model.mailReview, shown.deliveryID == delivery.id {
                Text("Review for \(shown.review.mode) mode").font(.subheadline.weight(.medium))
                Text(shown.review.notice).font(.footnote).foregroundStyle(.secondary)
                if let summary = shown.review.summary {
                    LabeledContent("To", value: summary.to.oneLine)
                    LabeledContent("From", value: summary.from.oneLine)
                    LabeledContent("Print", value: "\(summary.color ? "Color" : "Black and white"), \(summary.doubleSided ? "double-sided" : "single-sided")")
                    LabeledContent("Mail class", value: summary.mailingClass)
                } else {
                    Text("This instance did not return its server-side address and print summary. Review the record and document before confirming.").font(.footnote)
                }
                Text("An exact provider-rendered envelope proof and cost estimate are not available.").font(.footnote)
                Text(MailMode(rawValue: shown.review.mode)?.detail ?? "").font(.footnote)
                HStack {
                    Button("Cancel") { model.cancelReview() }
                    Spacer()
                    if model.approvingID == delivery.id { ProgressView().controlSize(.small) }
                    Button(shown.review.mode == "live" ? "Mail a real letter" : "Confirm test letter") {
                        Task { await model.approveMail(delivery); onChange() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!shown.review.available || model.approvingID != nil)
                }
            } else {
                Picker("Mode", selection: $mode) { ForEach(MailMode.allCases) { Text($0.label).tag($0) } }.pickerStyle(.segmented)
                Button("Review letter") { Task { await model.reviewMail(delivery, mode: mode) } }
                    .disabled(model.approvingID != nil)
            }
            if let error = model.approvalError { Text(error).font(.footnote).foregroundStyle(.orange) }
        }
    }
}
