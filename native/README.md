# simpledocs native apps

SwiftUI apps for macOS, iPad and iPhone that sign in to your own simpledocs instance and use its Worker API: send faxes and paper mail, read records and their delivery status, listen to voicemail, and edit settings. There is no built-in data. Everything on screen comes from the signed-in instance. See [self-hosted instances and App Store release](docs/self-hosted-instances.md) and [the implementation plan](../docs/plan.md).

## Screens

| Screen | What it does | Worker endpoints |
| --- | --- | --- |
| Sign in | Instance address and Cloudflare Access address, browser sign-in, session kept in the Keychain, last instance remembered. Shows "can't reach", "canceled" and "session ended" states. | OAuth discovery, registration, token |
| Send | Choose a PDF (file picker, or drag and drop on macOS and iPad) with name, size, page count and thumbnail. Fax numbers are normalized to E.164. Paper mail address, fax cover page, review step, then send. Live mail needs an extra confirmation. | `POST /api/transmissions`, `GET .../mail/:id/review`, `POST .../approve` |
| Records | Newest first, per-channel status badges, detail with timeline and PDF preview, pull to refresh, polling while a delivery is moving. A letter that was not approved can be reviewed and approved here. | `GET /api/records`, `GET /api/transmissions/:id`, document and cover downloads |
| Calls | Calls and voicemail, audio player, transcript, New/Heard, share or save, call back. | `GET /api/voice/calls`, `GET /api/voice/recordings`, `GET .../recordings/:id`, `POST .../heard` |
| Settings | Instance info, sender name and return address, voicemail greeting and voice, sign out. | `GET/PUT /api/settings`, `GET/PUT /api/settings/voicemail` |

macOS and iPad use a sidebar (`NavigationSplitView`); iPhone uses tabs. On macOS, New Send is ⌘N and Refresh is ⌘R.

Status wording comes from the provider. "Accepted by provider" and "Completed by PostGrid" are never shown as delivery.

Call back opens the phone's dialer with a `tel:` link. A dialer inside the app would need Telnyx's WebRTC SDK, which this project does not bundle.

The voicemail greeting editor uses `GET/PUT /api/settings/voicemail` (`{greeting, voice, service_level}`). That route only exists on a voice-enabled instance; on others it answers 404 and the screen says the instance doesn't support it. Push registration (`POST /api/push/devices`) runs after sign-in; see [push.md](docs/push.md).

## Layout

Shared SwiftUI screens are in `Apps/ConnectedShared`; the macOS connected app is in `Apps/MacConnected`, the direct edition in `Apps/MacDirect` (unchanged, still a preview with synthetic data) and iPhone/iPad in `Apps/iOS`. The models, sign-in, networking and view models live in Swift packages under `Packages/`; see [connected-integration.md](docs/connected-integration.md) for what each package does and how sessions work. `project.yml` is the [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec (the `.xcodeproj` is generated and not committed).

The two macOS editions are separate targets with separate bundle identifiers, product names and entitlements. The identifiers (`dev.justinharbour.simpledocs.mac.connected`, `.mac.direct`, `.ios`) are provisional and need confirming against the Apple Developer account before any signing.

## Build and test

Requires Xcode (the full app, not only Command Line Tools) and `brew install xcodegen`.

```sh
cd native
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # if xcode-select points at Command Line Tools

# Package tests (Swift Testing)
for p in Packages/*; do (cd $p && swift test); done
Packages/*Connected/ci/guard.sh

# Generate the project, then build each target without signing
xcodegen generate
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsMacConnected -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsMacDirect    -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsiOS          -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsSignInTests  -destination 'platform=macOS' test CODE_SIGNING_ALLOWED=NO
```

## For CI

The `native-connected` job in `.github/workflows/ci.yml` runs the guard and the package tests. The project is generated, so run `xcodegen generate` in `native/` before `xcodebuild`. Builds need a macOS runner with full Xcode, no secrets and `CODE_SIGNING_ALLOWED=NO`.

## Not verified

- **Sign-in against the live instance.** The app needs Managed OAuth turned on for the Access application with `dev.justinharbour.simpledocs:/oauth/callback` allowed. The Worker must accept the bearer token (Access turns it into the assertion) and the `Origin` header. Until that is checked end to end, sign-in may be refused.
- **No iOS simulator was run**, so the iOS app is built for `generic/platform=iOS` only.
- **No VoiceOver, keyboard-navigation or Dynamic Type pass.** Labels and system controls are in place; a manual pass is still needed.
- No signing, notarization or App Store Connect setup. Push delivery needs the Apple and Worker setup in [push.md](docs/push.md).
