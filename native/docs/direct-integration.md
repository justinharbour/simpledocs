# Direct-provider foundation

`Packages/SimpleDocsDirect` is a standalone macOS package, not yet linked to an app. It makes no network requests and implements no provider authentication, sending, retries, polling or webhook handling. All features are unavailable, including when credentials exist. Its eligibility result is not a substitute for enforcement at the eventual action boundary. Do not expose an action until provider capabilities and authorization are verified and all required safeguards are enforced, including proof approval for mail and safe idempotency for sends.

## Credential custody

The store uses Security generic-password items, one per provider, with a fixed service and provider account, non-synchronizable and `WhenUnlockedThisDeviceOnly`. Save replaces an existing value, load returns nil only for an absent item, and delete is idempotent. Other Keychain errors propagate as status codes; callers must not log credential data, Keychain query dictionaries, or include secrets in diagnostics. Empty values are rejected. The app must provide secure credential entry and explicit removal, minimize in-memory lifetime, use least-privilege provider credentials where available, and explain revocation separately from local deletion. A person controlling the device or process may extract local credentials; Keychain is not a guarantee against that. Device-only items do not migrate via backup and may need re-entry on a replacement device. Keychain accessibility, access groups and behavior under the actual signed, sandboxed app must be validated before integration; no signing or live Keychain integration test is included here.

## Inbound limitations

An installed app is not an always-on public webhook receiver. Incoming live calls, unattended capture, notifications and webhook processing are not provided. Historical event, fax document, voicemail and tracking retrieval remain unverified; they may require provider-supported retrieval while running or a separately hosted service. There is no guarantee of offline capture, completeness, delivery or timely notification. Do not enable inbound features on the strength of a stored credential. Local record storage, retention, deletion, backup and synchronization are not implemented or decided.

## Verification

Run `swift test` in `native/Packages/SimpleDocsDirect`. Tests use a fake Security API with arbitrary bytes, no real credentials or live provider traffic. They cover Keychain query construction, duplicate update, missing items, errors and fail-closed feature results; they do not establish signed-app Keychain behavior or provider compatibility. The shared package and app targets remain unchanged.
