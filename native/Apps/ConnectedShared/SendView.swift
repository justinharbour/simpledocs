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
    @State private var thumbnail: PlatformImage?
    @State private var confirmLive = false

    var body: some View {
        Group {
            switch model.step {
            case .compose: compose
            case .review, .sending: review
            case .sent(let summary): sent(summary)
            }
        }
        .navigationTitle("Send")
        .task { await model.prefill() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf]) { result in
            switch result {
            case .success(let url): load(url)
            case .failure: model.rejectDocument("That file couldn't be opened.")
            }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard let url = urls.first(where: { $0.pathExtension.lowercased() == "pdf" }) else {
                model.rejectDocument("Drop a PDF file.")
                return false
            }
            load(url)
            return true
        } isTargeted: { dropTargeted = $0 }
    }

    private func load(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            model.rejectDocument("That file couldn't be opened.")
            return
        }
        let pdf = PDFDocument(data: data)
        model.choose(data: data, name: url.lastPathComponent, pageCount: pdf?.pageCount)
        thumbnail = model.document == nil ? nil : firstPage(of: pdf)
    }

    // MARK: Compose

    private var compose: some View {
        Form {
            Section("Document") { documentRow }

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
                } header: { Text("Fax") } footer: {
                    Text("One per line or separated by commas. (213) 414-7728, 213-414-7728 and +12134147728 all work.")
                }

                Section("Cover page") {
                    Toggle("Include a cover page", isOn: $model.draft.cover.enabled)
                    if model.draft.cover.enabled {
                        TextField("To", text: $model.draft.cover.to)
                        TextField("From", text: $model.draft.cover.from)
                        TextField("Subject", text: $model.draft.cover.subject)
                        TextField("Message", text: $model.draft.cover.message, axis: .vertical).lineLimit(2...6)
                    }
                }
            }

            if model.draft.channels.hasMail {
                Section("Mail to") { ContactFields(contact: $model.draft.mailTo) }
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
                Button("Review") { model.review() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!model.canReview)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .formStyle(.grouped)
        .overlay { if dropTargeted { DropHint() } }
    }

    @ViewBuilder private var documentRow: some View {
        if let document = model.document {
            HStack(spacing: 14) {
                PDFThumbnail(image: thumbnail, height: 110).frame(width: 86)
                VStack(alignment: .leading, spacing: 4) {
                    Text(document.name).font(.headline).lineLimit(2)
                    Text("\(document.pageCount) \(document.pageCount == 1 ? "page" : "pages") · \(ByteCountFormatter.string(fromByteCount: Int64(document.byteCount), countStyle: .file))")
                        .font(.subheadline).foregroundStyle(.secondary)
                    HStack {
                        Button("Choose another") { importing = true }
                        Button("Remove", role: .destructive) { model.clearDocument(); thumbnail = nil }
                    }
                    .buttonStyle(.borderless)
                    .font(.callout)
                }
            }
            .accessibilityElement(children: .combine)
        } else {
            VStack(spacing: 10) {
                Image(systemName: "arrow.down.doc").font(.title).foregroundStyle(.secondary).accessibilityHidden(true)
                Text("Choose a PDF to send").font(.headline)
                #if os(iOS)
                Text("Up to 5 MB. You can also drop a PDF here on iPad.").font(.footnote).foregroundStyle(.secondary)
                #else
                Text("Up to 5 MB. You can also drop a PDF here.").font(.footnote).foregroundStyle(.secondary)
                #endif
                Button("Choose PDF…") { importing = true }.buttonStyle(.borderedProminent)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
        if let error = model.documentError { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).font(.callout) }
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
            Section("Document") {
                LabeledContent("File", value: model.document?.name ?? "")
                LabeledContent("Pages", value: "\(model.document?.pageCount ?? 0)")
            }
            if model.draft.channels.hasFax {
                Section("Fax") {
                    ForEach(model.draft.fax.numbers, id: \.self) { Text(PhoneNumber.display($0)) }
                    LabeledContent("Cover page", value: model.draft.cover.enabled ? "Included" : "None")
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
                    Button("Back") { model.backToCompose() }.disabled(sending)
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
        .confirmationDialog("Mail a real letter?", isPresented: $confirmLive, titleVisibility: .visible) {
            Button("Mail the letter", role: .destructive) { Task { await model.send() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("PostGrid will print and mail this letter to \(model.draft.mailTo.oneLine). This costs money and can't be undone.")
        }
    }

    // MARK: Sent

    private func sent(_ summary: SendModel.SentSummary) -> some View {
        VStack(spacing: 16) {
            Image(systemName: summary.letterProblem == nil ? "checkmark.circle" : "exclamationmark.triangle")
                .font(.system(size: 44)).foregroundStyle(summary.letterProblem == nil ? Color.green : Color.orange).accessibilityHidden(true)
            Text(summary.letterProblem == nil ? "Handed off" : "Partly handed off").font(.title2.bold())
            VStack(alignment: .leading, spacing: 6) {
                if summary.faxCount > 0 {
                    Label("\(summary.faxCount) \(summary.faxCount == 1 ? "fax" : "faxes") queued. Delivery isn't confirmed until the receiving machine answers.", systemImage: "clock")
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
                Button("Send another") { model.reset(); thumbnail = nil }
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
            .overlay { Label("Drop the PDF here", systemImage: "arrow.down.doc").font(.title3) }
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
