import AuthenticationServices
import SimpleDocsConnected
import SimpleDocsOAuth
import SwiftUI

#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor private final class Anchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
        #else
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        #endif
    }
}

@MainActor @Observable final class SignInModel {
    var instance = "" { didSet { if instance != oldValue { signOut() } } }
    var issuer = "" { didSet { if issuer != oldValue { signOut() } } }
    var preparation: SignInPreparation?
    var message = "No local session."
    var busy = false
    private var owner: SessionCoordinator?
    private var binding: ContextBinding?
    private var session: AppSession?
    private let anchor = Anchor()
    private var browser: OAuthBrowser?
    private let adapterFactory: ((OAuthBrowser) -> any ConnectedFlowAdapter)?

    init(adapterFactory: ((OAuthBrowser) -> any ConnectedFlowAdapter)? = nil) {
        self.adapterFactory = adapterFactory
    }

    func prepare() {
        signOut()
        do {
            let origin = try InstanceOrigin.parse(instance).get()
            guard let acknowledged = AcknowledgedOrigin(origin: origin, acknowledgedDisplay: origin.canonical) else { return }
            var registry = InstanceRegistry()
            let linked = try registry.link(acknowledged)
            let binding = ContextBinding(try registry.activate(linked.linkID))
            let owner = SessionCoordinator(registry: registry)
            let preparation = try SignInPreparation(registry: registry, binding: binding, configuredIssuer: issuer)
            self.owner = owner
            self.binding = binding
            self.preparation = preparation
            message = "Review both addresses before continuing. Confirmation does not verify their ownership."
        } catch { message = "Invalid instance or Cloudflare Access issuer. Check both addresses." }
    }

    func signIn() async {
        guard let owner, let binding, let preparation, !busy else { return }
        session?.signOut()
        browser?.cancel()
        session = nil
        browser = nil
        var attempt: AppSession?
        do {
            let confirmation = try preparation.confirm(resource: preparation.resource, issuer: preparation.issuer, registry: owner.registry)
            let browser = OAuthBrowser(anchorProvider: anchor)
            self.browser = browser
            let adapter = adapterFactory?(browser) ?? ConnectedHTTP(browser: browser)
            let flow = ConnectedFlow(owner: owner, adapter: adapter)
            let session = AppSession(flow: flow)
            self.flow = flow
            attempt = session
            self.session = session
            busy = true
            message = "Signing in…"
            try await session.signIn(confirmation: confirmation, binding: binding, callback: URL(string: "dev.justinharbour.simpledocs:/oauth/callback")!)
            guard self.session === session else { return }
            busy = false
            message = "Token acquired in memory. Worker access and record loading have not been verified."
        } catch {
            if let attempt {
                guard self.session === attempt else { return }
            }
            busy = false
            message = "Sign-in did not complete."
        }
    }

    func load() async {
        guard let flow else { return }
        do {
            let faxData = try await flow.perform(.listInboundFaxes)
            let voiceData = try await flow.perform(.listVoiceRecordings)
            let faxList = try JSONDecoder().decode(InboundFaxList.self, from: faxData)
            let voiceList = try JSONDecoder().decode(VoiceRecordingList.self, from: voiceData)
            faxes = faxList.records
            pendingFaxes = faxList.pendingCount
            recordings = voiceList.recordings
            loaded = true
            message = "Signed in."
        } catch {
            message = "Signed in, but records could not be loaded."
        }
    }

    func signOut() {
        flow?.clear()
        flow = nil
        faxes = []; pendingFaxes = 0; recordings = []; loaded = false
        session?.signOut()
        browser?.cancel()
        session = nil
        browser = nil
        owner = nil
        binding = nil
        preparation = nil
        busy = false
        message = "Signed out on this device."
    }
}

struct ConnectedSignInView: View {
    @State private var model = SignInModel()

    var body: some View {
        Form {
            Section("simpledocs") {
                TextField("Instance HTTPS origin", text: $model.instance)
                    .autocorrectionDisabled()
                TextField("Cloudflare Access issuer", text: $model.issuer)
                    .autocorrectionDisabled()
                Button("Review addresses") { model.prepare() }.disabled(model.busy)
            }
            if let preparation = model.preparation {
                Section("Confirm both addresses") {
                    LabeledContent("Instance", value: preparation.resource)
                    LabeledContent("Issuer", value: preparation.issuer)
                    Button("Confirm and sign in") { Task { await model.signIn() } }.disabled(model.busy)
                }
            }
            if model.loaded {
                Section("Received faxes") {
                    if model.pendingFaxes > 0 { Text("\(model.pendingFaxes) received fax(es) not yet archived") }
                    if model.faxes.isEmpty { Text("No archived faxes.") }
                    ForEach(model.faxes) { fax in
                        VStack(alignment: .leading) {
                            Text("Fax \(fax.faxId.prefix(8))")
                            Text(fax.receivedAt).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                Section("Voicemail and recordings") {
                    if model.recordings.isEmpty { Text("No recordings.") }
                    ForEach(model.recordings) { item in
                        VStack(alignment: .leading) {
                            Text(item.kind ?? "recording")
                            Text(item.archived_at).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
                Button("Refresh") { Task { await model.load() } }
            }
            Section { Text(model.message); Button("Sign out") { model.signOut() } }
        }
        .padding()
    }
}
