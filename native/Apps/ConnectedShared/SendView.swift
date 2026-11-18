import PDFKit
import SimpleDocsConnected
import SimpleDocsOAuth
import SwiftUI
import UniformTypeIdentifiers

struct SendView: View {
    @Bindable var model: SendModel
    let open: (String) -> Void
    @State private var importing = false
    @State private var dropTargeted = false
    @State private var reorderToken = UUID().uuidString
    @State private var confirmLive = false
    @State private var sharedFiles: [URL] = []
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            switch model.step {
            case .compose: compose
            case .order: order
            case .review, .sending: review
            case .sent(let summary): sent(summary)
            }
        }
        .navigationTitle("Send")
        .task { await model.prefill() }
        .task { await model.loadRecipients() }
        .onAppear { refreshSharedFiles() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { refreshSharedFiles() } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): load(urls)
            case .failure: model.rejectDocument("That file couldn't be opened.")
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard model.step == .compose, !urls.isEmpty else { return false }
            guard urls.allSatisfy({ $0.pathExtension.lowercased() == "pdf" }) else {
                model.rejectDocument("Drop PDF files only.")
                return false
            }
            load(urls)
            return true
        } isTargeted: { dropTargeted = $0 && model.step == .compose }
    }

    private func load(_ urls: [URL]) {
        for url in urls where model.step == .compose {
            loadOne(url)
            if model.documentError != nil { break }
        }
    }

    private func loadOne(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            model.rejectDocument("That file couldn't be opened.")
            return
        }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: PickedDocument.limit + 1) else {
            model.rejectDocument("That file couldn't be opened.")
            return
        }
        if let problem = PickedDocument.problem(for: data) { model.rejectDocument(problem); return }
        let pdf = PDFDocument(data: data)
        model.choose(data: data, name: url.lastPathComponent, pageCount: pdf?.isEncrypted == false ? pdf?.pageCount : nil)
    }

    // MARK: Compose

    private var compose: some View {
        Form {
            Section("Documents") {
                if !sharedFiles.isEmpty {
                    Text("Shared PDFs are kept on this device until removed. Add one to review; nothing sends automatically.")
                        .font(.footnote).foregroundStyle(.secondary)
                    ForEach(sharedFiles, id: \.self) { url in
                        HStack {
                            Button("Add shared PDF \(url.deletingPathExtension().lastPathComponent.prefix(8))") { loadOne(url) }
                            Spacer()
                            Button("Remove", role: .destructive) {
                                do { try FileManager.default.removeItem(at: url); refreshSharedFiles() }
                                catch { model.rejectDocument("The shared PDF couldn't be removed.") }
                            }
                        }
                    }
                }
                documentRows
                Toggle("Put the document number at the top of each page", isOn: $model.draft.numberDocumentPages)
                Text("Recipients will see the number on every document page sent by fax or paper mail. The original page is scaled slightly to make room. This does not change the fax cover.")
                    .font(.footnote).foregroundStyle(.secondary)
            }

            Section {
                Picker("Send by", selection: $model.draft.channels) {
                    ForEach(SendChannels.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                TextField("Title (optional)", text: $model.draft.title)
            }

            if model.draft.channels.hasFax {
                Section {
                    TextField("Fax numbers", text: $model.draft.faxList, axis: .vertical)
                        .lineLimit(2...6)
                        #if os(iOS)
                        .keyboardType(.phonePad)
                        #endif
                    faxFeedback
                    if let recent = model.recentRecipients, !recent.fax.isEmpty {
                        Menu("Previous fax recipients") {
                            ForEach(recent.fax, id: \.self) { number in
                                Button(number) { model.draft.faxList += model.draft.faxList.isEmpty ? number : ", " + number }
                            }
                        }
                    }
                    if let notice = model.recipientsNotice { Text(notice).font(.footnote).foregroundStyle(.secondary) }
                } header: { Text("Fax") } footer: {
                    Text("One per line or separated by commas. (213) 414-7728, 213-414-7728 and +12134147728 all work.")
                }

                Section("Cover page") {
                    Toggle("Include a cover page", isOn: $model.draft.cover.enabled)
                    if model.draft.cover.enabled {
                        Toggle("List envelope and document numbers on the cover", isOn: $model.draft.cover.includeNumbers)
                        TextField("To", text: $model.draft.cover.to)
                        TextField("From", text: $model.draft.cover.from)
                        TextField("Subject", text: $model.draft.cover.subject)
                        TextField("Message", text: $model.draft.cover.message, axis: .vertical).lineLimit(2...6)
                    }
                }
            }

            if model.draft.channels.hasMail {
                Section("Mail to") {
                    ContactFields(contact: $model.draft.mailTo)
                    if let recent = model.recentRecipients, !recent.mail.isEmpty {
                        Menu("Previous mail recipients") {
                            ForEach(Array(recent.mail.enumerated()), id: \.offset) { _, contact in
                                Button(contact.oneLine) { model.draft.mailTo = contact }
                            }
                        }
                    }
                }
                Section("Return address") { ContactFields(contact: $model.draft.mailFrom) }
                Section("Letter") {
                    Toggle("Color", isOn: $model.draft.color)
                    Toggle("Print on both sides", isOn: $model.draft.doubleSided)
                    Toggle("First class", isOn: $model.draft.firstClass)
                    Picker("Mode", selection: $model.draft.mode) {
                        ForEach(MailMode.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    Text(model.draft.mode.detail).font(.footnote).foregroundStyle(.secondary)
                }
            }

            Section {
                ForEach(model.problems, id: \.self) { problem in
                    Label(problem, systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(.secondary)
                }
                Button(model.documents.count > 1 ? "Set document order" : "Review") { model.review() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canReview)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .formStyle(.grouped)
        .overlay { if dropTargeted { DropHint() } }
    }

    private func refreshSharedFiles() {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.justinharbour.simpledocs") else { sharedFiles = []; return }
        let folder = container.appendingPathComponent("ShareInbox", isDirectory: true)
        sharedFiles = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]))?
            .filter { $0.pathExtension.lowercased() == "pdf" }.sorted { $0.lastPathComponent < $1.lastPathComponent } ?? []
    }

    @ViewBuilder private var documentRows: some View {
        Text("Up to 10 PDFs, 5 MB and 100 pages total.").font(.footnote).foregroundStyle(.secondary)
        ForEach(Array(model.documents.enumerated()), id: \.offset) { index, document in
            HStack {
                Text(document.name).lineLimit(2)
                Spacer()
                Button("Remove", role: .destructive) { model.removeDocument(at: index) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove \(document.name), document \(index + 1)")
            }
        }
        Button("Add PDFs…") { importing = true }.buttonStyle(.borderless)
        if let error = model.documentError { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.callout) }
    }

    private var order: some View {
        Form {
            Section("Set the document order") {
                Text("Drag a document or use Move up and Move down. Fax and paper mail follow this order.")
                    .font(.footnote).foregroundStyle(.secondary)
                ForEach(Array(model.documents.enumerated()), id: \.offset) { index, document in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(index + 1). \(document.name)")
                            .draggable("\(reorderToken):\(index)")
                        HStack {
                            Button("Move up") { model.moveDocument(from: index, to: index - 1) }
                                .disabled(index == 0).accessibilityLabel("Move up: \(document.name), document \(index + 1)")
                            Button("Move down") { model.moveDocument(from: index, to: index + 1) }
                                .disabled(index == model.documents.count - 1).accessibilityLabel("Move down: \(document.name), document \(index + 1)")
                        }
                        .buttonStyle(.borderless)
                    }
                    .dropDestination(for: String.self) { items, _ in
                        let prefix = "\(reorderToken):"
                        guard items.count == 1, let item = items.first, item.hasPrefix(prefix),
                              let from = Int(item.dropFirst(prefix.count)), model.documents.indices.contains(from), from != index else { return false }
                        model.moveDocument(from: from, to: index)
                        return true
                    }
                }
            }
            Section {
                HStack {
                    Button("Back") { model.backToCompose() }.buttonStyle(.borderless)
                    Spacer()
                    Button("Review") { model.review() }.buttonStyle(.borderedProminent)
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder private var faxFeedback: some View {
        let parsed = model.draft.fax
        if !parsed.numbers.isEmpty {
            Text("Sending to " + parsed.numbers.map(PhoneNumber.display).joined(separator: ", "))
                .font(.footnote).foregroundStyle(.secondary)
        }
        if !parsed.invalid.isEmpty {
            Text("Not a valid number: " + parsed.invalid.joined(separator: ", ")).font(.footnote).foregroundStyle(.orange)
        }
    }

    // MARK: Review

    private var review: some View {
        let sending = model.step == .sending
        return Form {
            Section("Cost and preparation") {
                if model.draft.channels.hasFax, let estimate = model.faxEstimate, estimate.rate >= 0, estimate.rate.isFinite {
                    let pages = model.pageCount + (model.draft.cover.enabled ? 1 : 0)
                    let count = model.draft.fax.numbers.count
                    Text("Fax estimate: \(estimate.rate * Double(pages * count), format: .currency(code: "USD").precision(.fractionLength(2...4)))")
                    Text("\(pages) page(s) × \(count) recipient(s) × $\(estimate.rate, specifier: "%.6f") per page. \(estimate.source). Actual charges can differ; verify rates and fees with your provider.").font(.footnote)
                } else if model.draft.channels.hasFax {
                    Text("A fax estimate is unavailable from this instance. Provider charges may apply.")
                }
                if model.draft.channels.hasMail { Text("Mail pricing is unavailable; provider charges may apply.") }
                Text("This app requests review-only preparation. Older instances that do not support it will reject the request.")
            }
            Section("Document order") {
                ForEach(Array(model.documents.enumerated()), id: \.offset) { index, document in
                    Text("\(index + 1). \(document.name) (\(document.pageCount) \(document.pageCount == 1 ? "page" : "pages"))")
                }
                LabeledContent("Total pages", value: "\(model.pageCount)")
                LabeledContent("Page headers", value: model.draft.numberDocumentPages ? "Document number on every page" : "None")
            }
            if model.draft.channels.hasFax {
                Section("Fax") {
                    ForEach(model.draft.fax.numbers, id: \.self) { Text(PhoneNumber.display($0)) }
                    LabeledContent("Cover page", value: model.draft.cover.enabled ? "Included" : "None")
                    if model.draft.cover.enabled && model.draft.cover.includeNumbers {
                        Text("Envelope and document numbers will be listed on the cover.").font(.footnote)
                    }
                }
            }
            if model.draft.channels.hasMail {
                Section("Paper mail") {
                    LabeledContent("To", value: model.draft.mailTo.oneLine)
                    LabeledContent("From", value: model.draft.mailFrom.oneLine)
                    LabeledContent("Options", value: [model.draft.color ? "Color" : "Black and white", model.draft.doubleSided ? "Double-sided" : "Single-sided", model.draft.firstClass ? "First class" : "Standard"].joined(separator: ", "))
                    LabeledContent("Mode", value: model.draft.mode.label)
                    Text(model.draft.mode.detail).font(.footnote)
                        .foregroundStyle(model.draft.mode == .live ? Color.orange : Color.secondary)
                }
            }
            if let error = model.error {
                Section { ErrorBanner(message: error) }
            }
            Section {
                HStack {
                    Button("Back") { model.backFromReview() }.disabled(sending)
                    Spacer()
                    if sending { ProgressView().controlSize(.small) }
                    Button(model.sendButtonTitle) {
                        if model.needsLiveConfirmation { confirmLive = true } else { Task { await model.send() } }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(sending)
                }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Create this transmission?", isPresented: $confirmLive, titleVisibility: .visible) {
            Button("Create transmission", role: .destructive) { Task { await model.send() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(model.draft.channels.hasMail ? "Deliveries are prepared for separate review. The letter to \(model.draft.mailTo.oneLine) requires its own confirmation. Older instances may reject this request." : "Fax packets are prepared for separate review. Older instances may reject this request.")
        }
    }

    // MARK: Sent

    private func sent(_ summary: SendModel.SentSummary) -> some View {
        VStack(spacing: 16) {
            Image(systemName: summary.letterProblem == nil ? "checkmark.circle" : "exclamationmark.triangle")
                .font(.system(size: 44)).foregroundStyle(summary.letterProblem == nil ? Color.green : Color.orange).accessibilityHidden(true)
            Text(summary.faxAwaitingReview > 0 || summary.letterProblem != nil ? "Review deliveries in the record" : "Transmission created").font(.title2.bold())
            if let number = summary.envelopeNumber { Text("Envelope \(number)").foregroundStyle(.secondary) }
            VStack(alignment: .leading, spacing: 6) {
                if summary.faxCount > 0 {
                    if summary.faxAwaitingReview > 0 {
                        Label("\(summary.faxAwaitingReview) fax packet(s) await separate review in the record.", systemImage: "doc.text.magnifyingglass")
                    }
                    if summary.faxCount > summary.faxAwaitingReview {
                        Label("\(summary.faxCount - summary.faxAwaitingReview) fax(es) were submitted by this instance. Check the record for their status.", systemImage: "clock")
                    }
                }
                if summary.letterApproved {
                    Label("Letter confirmed in \(model.draft.mode.label.lowercased()) mode. PostGrid reports the progress.", systemImage: "envelope")
                }
                if let problem = summary.letterProblem {
                    Label("The letter was created but not confirmed, so nothing was mailed. \(problem)", systemImage: "envelope.badge")
                        .foregroundStyle(.orange)
                }
            }
            .font(.callout)
            .frame(maxWidth: 460, alignment: .leading)
            HStack {
                Button("View record") { open(summary.transmissionID) }.buttonStyle(.borderedProminent)
                Button("Send another") { model.reset() }
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct DropHint: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 12)
            .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 3, dash: [8]))
            .background(Color.accentColor.opacity(0.08))
            .padding(8)
            .allowsHitTesting(false)
            .overlay { Label("Drop PDFs here", systemImage: "arrow.down.doc").font(.title3) }
    }
}

struct ContactFields: View {
    @Binding var contact: MailContact

    var body: some View {
        TextField("First name", text: $contact.firstName)
        TextField("Last name (optional)", text: $contact.lastName)
        TextField("Street address", text: $contact.addressLine1)
        TextField("Apartment, suite (optional)", text: $contact.addressLine2)
        TextField("City", text: $contact.city)
        TextField("State", text: $contact.provinceOrState)
            #if os(iOS)
            .textInputAutocapitalization(.characters)
            #endif
        TextField("ZIP code", text: $contact.postalOrZip)
            #if os(iOS)
            .keyboardType(.numbersAndPunctuation)
            #endif
    }
}
