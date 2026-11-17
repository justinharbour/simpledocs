import SimpleDocsCore
import SwiftUI

/// Placeholder for linking the app to a person's own instance. The address is only
/// format-checked in memory: it is not saved, contacted or used for anything.
struct InstanceSetupView: View {
    @State private var address = ""

    private var check: InstanceAddressCheck {
        InstanceAddress.check(address)
    }

    var body: some View {
        List {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Not available yet")
                            .font(.headline)
                        Text("Linking to your own instance is not implemented. This screen shows the planned steps only. Nothing is saved or contacted.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.orange)
                }
                .accessibilityElement(children: .combine)
            }

            Section {
                TextField("Instance address", text: $address, prompt: Text("https://simpledocs.example.com"))
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    #endif
                    .autocorrectionDisabled()
                    .textContentType(.URL)
                Text(check.message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Connect") {}
                    .disabled(true)
                    .accessibilityHint("Not available. Connecting to an instance is not implemented.")
            } header: {
                Text("Address")
            } footer: {
                Text("No instance address is built into the app. Each person uses the instance they deployed to their own Cloudflare account.")
            }

            Section("Planned steps") {
                ForEach(Array(InstanceOnboarding.steps.enumerated()), id: \.element.id) { index, step in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text("\(index + 1). \(step.title)")
                                .font(.headline)
                            Spacer()
                            Text(step.status.title)
                                .foregroundStyle(.secondary)
                        }
                        Text(step.detail)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .navigationTitle("Your instance")
    }
}
