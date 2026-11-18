import SimpleDocsConnected
import SimpleDocsOAuth
import SwiftUI

struct SignInView: View {
    @Bindable var model: ConnectedModel

    private var signingIn: Bool { model.state == .signingIn }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 6) {
                    Image(systemName: "doc.text.fill").font(.largeTitle).foregroundStyle(.tint).accessibilityHidden(true)
                    Text("simpledocs").font(.largeTitle.bold())
                    Text("Send faxes and letters, and read what comes back, from your own instance.")
                        .foregroundStyle(.secondary)
                }
                ConnectionModePicker()
                    .disabled(signingIn)

                if let notice = model.notice {
                    if notice.isError { ErrorBanner(message: notice.text) }
                    else { Label(notice.text, systemImage: "info.circle").foregroundStyle(.secondary) }
                }

                VStack(alignment: .leading, spacing: 14) {
                    field("Instance address", text: $model.instance, prompt: "https://simpledocs.example.com")
                    field("Cloudflare Access address", text: $model.issuer, prompt: "https://your-team.cloudflareaccess.com")
                }
                .disabled(signingIn)

                VStack(alignment: .leading, spacing: 10) {
                    Button {
                        Task { await model.signIn() }
                    } label: {
                        HStack {
                            if signingIn { ProgressView().controlSize(.small) }
                            Text(model.state == .expired ? "Sign in again" : "Sign in")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .keyboardShortcut(.defaultAction)
                    .disabled(signingIn)

                    if signingIn {
                        Button("Cancel", role: .cancel) { model.cancelSignIn() }
                            .frame(maxWidth: .infinity)
                    }

                    Text("You'll sign in at \(model.issuerHost) and return here. The app will use \(model.instanceHost). Only continue if you trust both addresses.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
    }

    private func field(_ title: String, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline.weight(.medium))
            TextField(title, text: text, prompt: Text(prompt))
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
                #endif
                .labelsHidden()
        }
    }
}

extension ConnectedModel {
    var issuerHost: String { URL(string: issuer)?.host ?? issuer }
}
