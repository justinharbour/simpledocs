import SimpleDocsConnected
import SimpleDocsOAuth
import SwiftUI

struct SettingsView: View {
    @Bindable var model: SettingsModel
    let session: ConnectedModel
    @State private var confirmSignOut = false

    var body: some View {
        Form {
            Section("Connection") {
                ConnectionModePicker()
            }
            Section("Instance") {
                LabeledContent("Address", value: session.instanceHost)
                LabeledContent("Sign-in", value: session.issuerHost)
                if let fax = model.faxFrom { LabeledContent("Fax number", value: PhoneNumber.display(fax)) }
            }

            if let message = model.phase.error {
                Section { ErrorBanner(message: message) { Task { await model.load() } } }
            }

            Section {
                TextField("Sender name", text: $model.senderName)
                ContactFields(contact: $model.mailFrom)
                Button("Save sender details") { Task { await model.saveSender() } }
                    .disabled(!model.senderChanged || model.saving)
            } header: { Text("Sender") } footer: {
                Text("The name appears on fax cover pages. The return address is used for paper mail.")
            }

            voicemail

            if let message = model.saveMessage { Section { Label(message, systemImage: "checkmark.circle").foregroundStyle(.green) } }
            if let message = model.saveError { Section { ErrorBanner(message: message) } }

            Section {
                LabeledContent("Paper mail", value: "Choose Test or Live each time you send")
                Text("Test mode prints and mails nothing. Live mode mails a real letter after you confirm.")
                    .font(.footnote).foregroundStyle(.secondary)
            } header: { Text("Paper mail") }

            Section {
                Button("Sign out", role: .destructive) { confirmSignOut = true }
            } footer: {
                Text("Signing out removes the session from this device. It doesn't revoke it at Cloudflare.")
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Settings")
        .task { await model.load() }
        .confirmationDialog("Sign out of \(session.instanceHost)?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { session.signOut() }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder private var voicemail: some View {
        Section {
            switch model.voicemail {
            case .loading:
                ProgressView()
            case .missingOnInstance:
                Label("This instance doesn't support editing the voicemail greeting yet. Update the Worker to turn it on.", systemImage: "info.circle")
                    .font(.callout).foregroundStyle(.secondary)
            case .failed(let message):
                ErrorBanner(message: message) { Task { await model.load() } }
            case .editable:
                Picker("Voice", selection: presetSelection) {
                    ForEach(VoicePreset.all) { Text($0.label).tag($0.id) }
                    Text("Custom voice ID").tag(customTag)
                }
                if model.customVoice {
                    TextField("Voice ID", text: $model.voice)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                }
                VStack(alignment: .leading, spacing: 4) {
                    TextField("Greeting", text: $model.greeting, axis: .vertical).lineLimit(3...8)
                    Text("\(model.greetingRemaining) characters left")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(model.greetingRemaining < 0 ? Color.red : Color.secondary)
                        .accessibilityLabel("\(model.greetingRemaining) characters left")
                }
                Button("Save greeting") { Task { await model.saveVoicemail() } }
                    .disabled(!model.voicemailChanged || model.saving || model.greetingRemaining < 0)
            }
        } header: { Text("Voicemail greeting") } footer: {
            Text("Callers hear this when you don't pick up.")
        }
    }

    private let customTag = "__custom__"

    private var presetSelection: Binding<String> {
        Binding(
            get: { model.customVoice ? customTag : model.voice },
            set: { value in
                if value == customTag { if !model.customVoice { model.voice = "" } } else { model.voice = value }
            })
    }
}
