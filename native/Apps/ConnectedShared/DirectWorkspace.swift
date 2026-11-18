import SimpleDocsDirect
import SwiftUI
import PDFKit
import UniformTypeIdentifiers

struct ConnectionModePicker: View {
    @AppStorage("connectionMode") private var mode = "instance"
    var body: some View {
        Picker("Connection", selection: $mode) {
            Text("Self-hosted instance").tag("instance")
            Text("Provider API key").tag("direct")
        }
    }
}

struct DirectWorkspace: View {
    @State private var key = ""
    @State private var stored = false
    @State private var records: [DirectFax] = []
    @State private var loaded = false
    @State private var loading = false
    @State private var message: String?
    @State private var connection = ""
    @State private var from = ""
    @State private var to = ""
    @State private var pdf: Data?
    @State private var filename = ""
    @State private var importing = false
    @State private var reviewing = false
    @State private var submitting = false
    @State private var sendMessage: String?
    @State private var sharedFiles: [URL] = []
    @Environment(\.scenePhase) private var scenePhase
    private let store = CredentialStore()

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    ConnectionModePicker()
                    Text("Direct mode supports sending one PDF fax and reading the first page of Telnyx fax records. Calls, voicemail, mail, notifications and document downloads are not available.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Send a fax") {
                    TextField("Telnyx fax connection ID", text: $connection)
                    TextField("From (E.164)", text: $from)
                    TextField("To (E.164)", text: $to)
                    Button("Choose PDF") { importing = true }
                    ForEach(sharedFiles, id: \.self) { url in
                        HStack {
                            Button("Use shared PDF \(url.deletingPathExtension().lastPathComponent.prefix(8))") { loadPDF(url) }
                            Spacer()
                            Button("Remove", role: .destructive) {
                                do { try FileManager.default.removeItem(at: url); refreshSharedFiles() }
                                catch { sendMessage = "Could not remove the shared PDF." }
                            }
                        }
                    }
                    if pdf != nil { Text(filename) }
                    Button("Review fax") { reviewing = true }.disabled(pdf == nil || !stored || submitting)
                    if let sendMessage { Text(sendMessage).foregroundStyle(.secondary) }
                }
                Section("Telnyx API key") {
                    SecureField("API key", text: $key)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                    Button("Save key") { save() }.disabled(key.isEmpty || loading)
                    if stored {
                        Button("Remove key", role: .destructive) { remove() }.disabled(loading)
                    }
                    Text("Stored in this device's Keychain. Fetching sends the key directly to Telnyx; use a restricted key where possible.")
                        .font(.footnote).foregroundStyle(.secondary)
                    Text("Switching modes keeps your instance session and saved key on this device. Remove the key or sign out separately if needed.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Fax records") {
                    Button(loading ? "Loading…" : "Fetch fax records") { Task { await fetch() } }
                        .disabled(!stored || loading)
                    if let message { Text(message).foregroundStyle(.secondary) }
                    if loaded && records.isEmpty { Text("No fax records on this page.").foregroundStyle(.secondary) }
                    ForEach(records) { fax in
                        VStack(alignment: .leading) {
                            Text(fax.direction ?? "Direction unavailable").font(.headline)
                            Text("Status: \(fax.status ?? "Unavailable")")
                            if let from = fax.from { Text("From: \(from)") }
                            if let to = fax.to { Text("To: \(to)") }
                            if let date = fax.created_at { Text(date).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                    if loaded { Text("Showing up to 25 records from the first page.").font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Provider connection")
            .onAppear { checkKey(); refreshSharedFiles() }
            .onChange(of: scenePhase) { _, phase in if phase == .active { refreshSharedFiles() } }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf]) { result in
                guard case .success(let url) = result else { return }
                loadPDF(url)
            }
            .sheet(isPresented: $reviewing) {
                if let pdf {
                    NavigationStack {
                        VStack(alignment: .leading) {
                            Text("From: \(from)")
                            Text("To: \(to)")
                            Text("Connection: \(connection)")
                            Text("\(filename) · \(PDFDocument(data: pdf)?.pageCount ?? 0) pages")
                            Text("Telnyx pricing applies; no estimate is available. Sending submits this PDF and may incur charges.").font(.footnote)
                            DirectPDFPreview(data: pdf).frame(minHeight: 300)
                            HStack {
                                Button("Cancel") { reviewing = false }.disabled(submitting)
                                Spacer()
                                Button("Send fax") { Task { await sendFax(pdf) } }.disabled(submitting)
                            }
                        }.padding().navigationTitle("Review fax")
                    }.interactiveDismissDisabled(submitting)
                }
            }
        }
    }

    private func refreshSharedFiles() {
        guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.com.justinharbour.simpledocs") else { sharedFiles = []; return }
        sharedFiles = ((try? FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("ShareInbox", isDirectory: true), includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? [])
            .filter { $0.pathExtension.lowercased() == "pdf" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func loadPDF(_ url: URL) {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let handle = try? FileHandle(forReadingFrom: url) else { sendMessage = "Could not open the PDF."; return }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: 20 * 1024 * 1024 + 1), data.count <= 20 * 1024 * 1024,
              let document = PDFDocument(data: data), !document.isEncrypted, document.pageCount > 0 else {
            sendMessage = "Choose a readable PDF no larger than 20 MB."; return
        }
        pdf = data; filename = url.lastPathComponent; sendMessage = nil
    }

    private func checkKey() {
        do { stored = try store.load(for: .telnyx) != nil }
        catch { stored = false; message = "The Keychain could not be accessed. Try again after unlocking this device." }
    }
    private func save() {
        guard !key.isEmpty, key.utf8.count <= 4096, key.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }) else {
            message = "Enter a valid API key without spaces or line breaks."; return
        }
        do {
            try store.save(Data(key.utf8), for: .telnyx)
            key = ""; stored = true; records = []; loaded = false; message = "Key saved. Fetch records to check access."
        } catch { message = "The key could not be saved in the Keychain." }
    }
    private func remove() {
        do { try store.delete(for: .telnyx); stored = false; key = ""; records = []; loaded = false; message = "Key removed from this device." }
        catch { message = "The key could not be removed from the Keychain." }
    }
    private func fetch() async {
        loading = true; message = nil; records = []; loaded = false
        defer { loading = false }
        do {
            guard let data = try store.load(for: .telnyx), let secret = String(data: data, encoding: .utf8) else {
                stored = false; message = "Save a Telnyx API key first."; return
            }
            records = try await TelnyxFaxes().list(key: secret)
            loaded = true
        } catch DirectFaxError.unauthorized { message = "Telnyx rejected this key or its permissions." }
        catch DirectFaxError.invalidKey { message = "The saved key is invalid. Replace it in Settings." }
        catch DirectFaxError.invalidResponse { message = "Telnyx returned an unexpected response." }
        catch { message = "Unable to load records. Check your connection and try again." }
    }

    private func sendFax(_ reviewedPDF: Data) async {
        guard !submitting else { return }
        submitting = true
        defer { submitting = false }
        do {
            guard let data = try store.load(for: .telnyx), let secret = String(data: data, encoding: .utf8) else {
                sendMessage = "The Telnyx key is unavailable."; reviewing = false; return
            }
            let fax = try await TelnyxFaxes().send(key: secret, connection: connection, from: from, to: to, pdf: reviewedPDF)
            sendMessage = "Telnyx accepted fax \(fax.id). Status: \(fax.status ?? "unknown"). Acceptance is not delivery."
            pdf = nil; reviewing = false
        } catch DirectFaxError.outcomeUnknown {
            sendMessage = "The result is unknown. Check Telnyx fax records before sending again; the fax may already be queued."
            pdf = nil; reviewing = false
        } catch DirectFaxError.unauthorized { sendMessage = "Telnyx rejected the key or its permissions."; reviewing = false }
        catch DirectFaxError.rejected(let status) { sendMessage = "Telnyx rejected the request (\(status)). Check your account and fax settings."; reviewing = false }
        catch { sendMessage = "Check the connection ID, E.164 numbers, PDF and saved key."; reviewing = false }
    }
}

#if os(macOS)
struct DirectPDFPreview: NSViewRepresentable {
    let data: Data
    func makeNSView(context: Context) -> PDFView { let view = PDFView(); view.autoScales = true; view.document = PDFDocument(data: data); return view }
    func updateNSView(_ view: PDFView, context: Context) {}
}
#else
struct DirectPDFPreview: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView { let view = PDFView(); view.autoScales = true; view.document = PDFDocument(data: data); return view }
    func updateUIView(_ view: PDFView, context: Context) {}
}
#endif
