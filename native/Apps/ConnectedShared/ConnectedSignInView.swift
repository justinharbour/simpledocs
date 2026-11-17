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
    var message = "No local session. Workspace records are samples."
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
            let session = AppSession(flow: ConnectedFlow(owner: owner, adapter: adapter))
            attempt = session
            self.session = session
            busy = true
            message = "Signing in…"
            try await session.signIn(confirmation: confirmation, binding: binding, callback: URL(string: "dev.justinharbour.simpledocs:/oauth/callback")!)
            guard self.session === session else { return }
            busy = false
            message = "Token acquired in memory. Worker access has not been verified; workspace records are samples."
        } catch {
            if let attempt {
                guard self.session === attempt else { return }
            }
            busy = false
            message = "Sign-in did not complete. OAuth configuration and callback support must be verified."
        }
    }

    func signOut() {
        session?.signOut()
        browser?.cancel()
        session = nil
        browser = nil
        owner = nil
        binding = nil
        preparation = nil
        busy = false
        message = "Local session cleared. Provider revocation was not attempted."
    }
}

struct ConnectedSignInView: View {
    @State private var model = SignInModel()

    var body: some View {
        Form {
            Section("Experimental connected sign-in") {
                Text("The workspace shows sample data, not records from your instance. Sign-in requires a configured OAuth callback and does not yet connect the workspace.")
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
            Section { Text(model.message); Button("Sign out locally") { model.signOut() } }
        }
        .padding()
    }
}
