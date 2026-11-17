# simpledocs native apps

Wave 1 foundation for the SwiftUI iOS and macOS apps. It is a **preview with synthetic data**. Nothing here connects to an instance or a provider, there is no sign-in or credential entry, and nothing can be sent. People are expected to deploy their own instance to their own Cloudflare account, so no instance address is built in. See [self-hosted instances and App Store release](docs/self-hosted-instances.md). See [the implementation plan](../docs/plan.md).

## Layout

| Path | Purpose |
| --- | --- |
| `Packages/SimpleDocsKit` | Shared Swift package. `SimpleDocsCore` holds editions, capabilities, models and synthetic data. `SimpleDocsViews` holds the shared SwiftUI interface. |
| `Apps/MacConnected` | macOS edition that links to a person's own self-deployed instance (not yet connected). |
| `Apps/MacDirect` | macOS direct-provider edition (no provider access yet). |
| `Apps/iOS` | iOS skeleton. iOS always uses the connected-instance model. |
| `project.yml` | [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec. The `.xcodeproj` is generated and not committed. |
| `Config` | Per-edition entitlements. |

The two macOS editions are separate targets with separate bundle identifiers, product names and entitlements, so they can be signed and distributed independently. The identifiers (`dev.justinharbour.simpledocs.mac.connected`, `.mac.direct`, `.ios`) are provisional and need confirming against the Apple Developer account before any signing.

## Build and test

Requires Xcode (the full app, not only Command Line Tools) and `brew install xcodegen`.

```sh
cd native
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # if xcode-select points at Command Line Tools

# Shared package tests (Swift Testing)
(cd Packages/SimpleDocsKit && swift test)

# Generate the project, then build each target without signing
xcodegen generate
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsMacConnected  -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsMacDirect -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsiOS       -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO
```

## For CI

Schemes and targets are `SimpleDocsMacConnected`, `SimpleDocsMacDirect` and `SimpleDocsiOS`. `SimpleDocsMacConnected` was renamed from `SimpleDocsMacOwner`, so any job or script that still names the old scheme will fail. The project is generated, so run `xcodegen generate` in `native/` before `xcodebuild`. No workflow for `native/` exists yet. A check needs a macOS runner with full Xcode and no secrets, and must build with `CODE_SIGNING_ALLOWED=NO`. The package tests (`swift test` in `Packages/SimpleDocsKit`) need no Xcode project.

## What is in this foundation

- A sidebar and detail workspace using `NavigationSplitView`, `List`, `ContentUnavailableView` and system controls, so macOS and iOS get native navigation, keyboard support and Dynamic Type. Starwind UI is web-only and is not used here.
- A "Sample state" toolbar menu to preview empty, sample records, loading and error states.
- A "Your instance" placeholder for the connected edition: planned onboarding steps marked not implemented, not published or not decided, and an address field that checks format only (https origin, no credentials or path). It saves and contacts nothing, and the Connect button is disabled.
- Honest status semantics: provider wording is shown separately from a normalized status, "Provider reports complete" is never presented as delivery, and proof approval states (pending, ready, approved, invalidated) are modeled. A job's overall outcome follows a fixed precedence (see `CommunicationJob.outcome`): active work and pending approval come first, completed work beside failed, canceled or unsent deliveries is "partly complete", and settled results stay listed beside an active or pending delivery. Tests cover the precedence table and every combination of statuses.
- Per-edition capability and limitation screens. The direct edition states that there is no webhook receiver, that unattended capture is not guaranteed, that a local credential can be extracted by someone who controls the device, and that records stay local.
- Synthetic fixtures only: names marked "Sample", reserved `555 01xx` numbers, `Example Way` addresses.

## Deliberately not included

- No signing identity, team, provisioning, notarization or distribution. Targets build with `CODE_SIGNING_ALLOWED=NO`.
- No networking or `com.apple.security.network.client` entitlement. Add it only in the change that adds a verified connection.
- No instance connection, sign-in, token handling, Keychain storage, provider SDKs, WebRTC or local record store. Each needs verification first (see the plan's open decisions).
- No CI workflow. Workflows live outside `native/`, which this change does not touch. A macOS check can run the commands above on a standard hosted runner.

## Verification and limitations

Verified locally with Xcode 27.2 on macOS 27.2:

- `swift test`: 28 tests pass (outcome precedence table and exhaustive status combinations, instance address checks, onboarding, edition limitations, fixtures, view construction for every edition and scenario, accessibility labels). The outcome tests were also run against the earlier logic and fail there.
- All three targets build unsigned. Both macOS apps launch.

Not verified:

- **No iOS simulator runtime is installed**, so the iOS app was built for `generic/platform=iOS` but never launched or run in tests.
- **No UI automation, VoiceOver, keyboard-navigation or Dynamic Type run was performed.** Accessibility is by construction (system controls, combined and explicit labels, text rather than color alone, `help` and hints). It needs a manual pass with VoiceOver, Full Keyboard Access and the largest accessibility text sizes.
- No signing, App Store Connect setup, privacy policy or review-access plan exists. The package declares macOS 14 and iOS 17 as provisional minimums. Confirm the minimums as the plan's open decisions require.
- Hardened runtime is set on the macOS targets, but nothing was signed or notarized.
- The Impeccable design review the plan requires has not been done.
