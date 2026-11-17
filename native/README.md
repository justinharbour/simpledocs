# simpledocs native apps

Wave 1 foundation for the SwiftUI iOS and macOS apps. It is a **preview with synthetic data**. Nothing here connects to a backend or a provider, there is no credential entry, and nothing can be sent. See [the implementation plan](../docs/plan.md).

## Layout

| Path | Purpose |
| --- | --- |
| `Packages/SimpleDocsKit` | Shared Swift package. `SimpleDocsCore` holds editions, capabilities, models and synthetic data. `SimpleDocsViews` holds the shared SwiftUI interface. |
| `Apps/MacOwner` | macOS owner edition, backend-connected (not yet connected). |
| `Apps/MacDirect` | macOS direct-provider edition (no provider access yet). |
| `Apps/iOS` | iOS owner skeleton. iOS is always the backend-connected model. |
| `project.yml` | [XcodeGen](https://github.com/yonaskolb/XcodeGen) spec. The `.xcodeproj` is generated and not committed. |
| `Config` | Per-edition entitlements. |

The two macOS editions are separate targets with separate bundle identifiers, product names and entitlements, so they can be signed and distributed independently. The identifiers (`dev.justinharbour.simpledocs.mac.owner`, `.mac.direct`, `.ios`) are provisional and need confirming against the Apple Developer account before any signing.

## Build and test

Requires Xcode (the full app, not only Command Line Tools) and `brew install xcodegen`.

```sh
cd native
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # if xcode-select points at Command Line Tools

# Shared package tests (Swift Testing)
(cd Packages/SimpleDocsKit && swift test)

# Generate the project, then build each target without signing
xcodegen generate
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsMacOwner  -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsMacDirect -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project SimpleDocs.xcodeproj -scheme SimpleDocsiOS       -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO
```

## What is in this foundation

- A sidebar and detail workspace using `NavigationSplitView`, `List`, `ContentUnavailableView` and system controls, so macOS and iOS get native navigation, keyboard support and Dynamic Type. Starwind UI is web-only and is not used here.
- A "Sample state" toolbar menu to preview empty, sample records, loading and error states.
- Honest status semantics: provider wording is shown separately from a normalized status, "Provider reports complete" is never presented as delivery, partial success across channels is explicit, and proof approval states (pending, ready, approved, invalidated) are modeled.
- Per-edition capability and limitation screens. The direct edition states that there is no webhook receiver, that unattended capture is not guaranteed, that a local credential can be extracted by someone who controls the device, and that records stay local.
- Synthetic fixtures only: names marked "Sample", reserved `555 01xx` numbers, `Example Way` addresses.

## Deliberately not included

- No signing identity, team, provisioning, notarization or distribution. Targets build with `CODE_SIGNING_ALLOWED=NO`.
- No networking or `com.apple.security.network.client` entitlement. Add it only in the change that adds a verified connection.
- No Cloudflare Access/Entra sign-in, token handling, Keychain storage, provider SDKs, WebRTC or local record store. Each needs verification first (see the plan's open decisions).
- No CI workflow. Workflows live outside `native/`, which this change does not touch. A macOS check can run the commands above on a standard hosted runner.

## Verification and limitations

Verified locally with Xcode 27.2 on macOS 27.2:

- `swift test`: 17 tests pass (models, outcomes, edition limitations, fixtures, view construction for every edition and scenario, accessibility labels).
- All three targets build unsigned. Both macOS apps launch.

Not verified:

- **No iOS simulator runtime is installed**, so the iOS app was built for `generic/platform=iOS` but never launched or run in tests.
- **No UI automation, VoiceOver, keyboard-navigation or Dynamic Type run was performed.** Accessibility is by construction (system controls, combined and explicit labels, text rather than color alone, `help` and hints). It needs a manual pass with VoiceOver, Full Keyboard Access and the largest accessibility text sizes.
- The package declares macOS 14 and iOS 17 as provisional minimums. Confirm the minimums as the plan's open decisions require.
- Hardened runtime is set on the macOS targets, but nothing was signed or notarized.
- The Impeccable design review the plan requires has not been done.
