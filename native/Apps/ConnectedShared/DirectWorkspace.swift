import SimpleDocsDirect
import SwiftUI

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
    private let store = CredentialStore()

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection") {
                    ConnectionModePicker()
                    Text("Direct mode currently reads the first page of Telnyx fax records only. Sending, calls, voicemail, mail, notifications and document downloads are not available.")
                        .font(.footnote).foregroundStyle(.secondary)
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
            .onAppear { checkKey() }
        }
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
}
