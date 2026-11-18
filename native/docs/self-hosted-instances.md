# Self-hosted instances and App Store release: assessment

Status: assessment only. Nothing described here as planned is implemented. The native apps contain no instance address, no networking and no sign-in.

## Direction

Other people deploy their own simpledocs instance to their own Cloudflare account and link the Apple apps to it. An App Store release is intended. The apps therefore must not assume an owner-run endpoint. The connected edition asks each person for the address of their own instance; the direct-provider edition does not use an instance.

## What the foundation now does

- The connected edition is `connectedInstance` (was `ownerBackend`). The macOS and iOS main targets use `com.justinharbour.simpledocs`. Direct Telnyx fax records and reviewed submission are implemented but require CI and provider verification. See the native README for migration and signing implications.
- A "Your instance" screen shows the planned onboarding steps, each labelled not implemented, not published or not decided. The Connect button is disabled.
- The address field only checks format (https origin, no credentials, path, query or fragment). It does not save or contact the address, and the UI says a valid format does not show a simpledocs instance exists.
- Tests assert that no owner host name appears in app text.

## Deploying an instance

**Deploy to Cloudflare button** (Cloudflare documentation, checked 2026-11-16):

- It clones a public GitHub or GitLab repository into the user's account, provisions D1, R2, KV, Queues and similar bindings, and builds with Workers Builds.
- Workers only; Pages applications are not supported.
- Monorepo subdirectories must be fully self-contained, or the build fails. If the Worker lives in a repository with other packages, it needs an isolated subdirectory or its own repository.
- Secrets are declared in `.dev.vars.example` or `.env.example`; binding descriptions go in `package.json`.

A deployable Worker does not exist in this repository yet, so the button is not usable. Deploy to Cloudflare is the only deployment route considered here.

## Open decisions for self-hosted instances

1. **Sign-in.** The plan assumes the owner's Cloudflare Access and Entra setup. Other people will not have that tenant. Options include per-instance Access with the user's own identity provider, or instance-issued credentials. It must be chosen and verified before building, and no service token or provider key may be embedded in the app.
2. **Instance discovery and compatibility.** Define how the app confirms an address is a simpledocs instance, its API version, and what to do when the app and instance versions differ.
3. **Address trust.** Require https, show the host the app is connected to, and decide how to handle an address change and how to forget an instance.
4. **Feature controls and provider setup.** Each instance holds its own provider credentials as Cloudflare secrets. The app should display what the instance reports and should not assume a channel is on.
5. **Data location.** Records live in the user's own Cloudflare account. The privacy policy and App Store privacy answers must say the publisher does not receive them, once that is true.
6. **Updates and support.** Instances will lag the app. Decide the support window and the migration path.

## App Store considerations

These come from Apple's App Review Guidelines (fetched 2026-11-16) and need the owner's confirmation against current App Store Connect requirements.

- **Review access.** Apple asks for a demo account or a fully featured demo mode, and for backend services to be live during review. An app that needs a self-deployed instance has no backend of its own. Plan either a built-in demo mode that shows synthetic data (the existing sample states are a starting point, but they are not a demo of verified behavior) or a publisher-run, clearly labelled demo instance. Apple states a demo mode in place of an account needs prior approval.
- **Account sign-in and deletion.** If the app supports account creation it must offer in-app account deletion. Account creation here would belong to each instance; decide what the app can honestly offer.
- **Mac App Store.** If the macOS apps go to the Mac App Store they must be sandboxed (they are) and need `com.apple.security.network.client` once networking exists. That entitlement is deliberately not added yet. The plan's Developer ID direct downloads are a separate route.
- **Direct-provider edition.** It keeps provider credentials on the device. Whether it is distributed through the App Store, as a direct download, or both is undecided. Keep its limitations (no webhook receiver, no unattended capture guarantee, local credential extractable) visible in any listing.
- **Paid communications.** Sending paid fax or mail through a user's own accounts keeps the proof-approval gate. Review the listing and metadata so they do not imply delivery guarantees.
- **Listing text and privacy.** Do not describe unimplemented features. Provide a privacy policy URL and accurate privacy answers.

Not done: signing, notarization, App Store Connect setup, bundle ID registration, privacy policy or screenshots.
