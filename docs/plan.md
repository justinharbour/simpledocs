# Implementation plan

This is a design and delivery plan, not a statement that functionality exists.

## Architecture

Build an Astro static interface using Starwind UI and a Worker API. Prefer Cloudflare Zero Trust alongside Deploy to Cloudflare; if not feasible, use an explicitly configured and verified Better Auth mode with environment secrets. Each instance independently selects and verifies its authentication and authorization; the owner's existing Entra-backed Access is an option, not a universal dependency. Protect application data and mutations with validated mode-specific assertions or sessions and CSRF protections. No auth mode is assumed to be automatically provisioned. Expose provider webhook endpoints separately from interactive authentication, authenticate them using each provider's documented signature mechanism, and reject stale or replayed requests. First deployment fails closed; never silently fall back to another mode or unauthenticated access.

Use D1 for configuration, communication jobs, channel deliveries, audit events, provider IDs, statuses and metadata. Use private R2 objects for source documents, generated proofs, fax artifacts and voicemail. Serve objects only through authorized endpoints. Introduce `simpledocs-queue-prod` if necessary for reliable webhook processing, retries and asynchronous provider work; acknowledge events only after durable acceptance. Model duplicate and out-of-order events and use idempotency keys to avoid duplicate paid sends.

Manage independent Simpledocs Cloudflare infrastructure and the Worker through this repository's reviewed GitHub Actions and Wrangler ownership, not duplicate OpenTofu or unmanaged resources. Production uses `simpledocs-wkr-prod`, `simpledocs-d1-prod`, `simpledocs-r2-prod`, and canonical `simpledocs.justinharbour.com`. Keep `.dev` as production compatibility until a separately reviewed and isolated preview cutover. Validate DNS ownership, permissions, data retention, recovery and backups. Never expose secrets to untrusted PRs; runtime credentials must be supplied through the approved deployment workflow.

## Fax and voice

Integrate the current Telnyx SDK and browser WebRTC SDK with short-lived, least-privilege credentials. Securely receive and archive fax documents and delivery confirmations. Implement outbound and inbound calls, call-state transitions, disconnect/error handling, and voicemail with private recording storage. Individually gate outbound fax, inbound fax, outbound voice, inbound voice and voicemail on the server, not just in the interface. Validate Telnyx account and number capabilities and routing before presenting a shared-number setup as available; do not silently change provider routing.

## Paper mail and multi-channel delivery

Use PostGrid's supported mailing-class values without claiming a class, return receipt, or tracking exists for every destination or product. Capture class, extra services, provider IDs, status changes, tracking number and carrier/IMB details when available. Preserve raw provider status separately from normalized status; never label an estimated completion as confirmed delivery. Save provider-generated proofs, receipts and artifacts when available.

The owner clarified that a programmatically generated local review is acceptable; a provider-generated pre-send proof is not required. The review and explicit confirmation must bind the exact recipient, contents and print options to the submitted revision; invalidate confirmation on change. Clearly disclose that local rendering is not a PostGrid proof and may differ from printed output. Ordinary provider previews are generated after order creation, which can initiate a paid, time-sensitive order. Retain delivery evidence separately.

Create a parent job with independent fax and mail deliveries, each with its own approval, idempotency key, status, provider reference and failure/retry state. Make partial successes explicit; never automatically resend a successful channel when another fails.

## Native iOS and macOS apps

Build native Swift apps with SwiftUI and platform-specific integrations where appropriate, sharing domain models, validation and communication workflows through Swift packages while retaining native navigation, accessibility and system behavior. Starwind UI applies to the web, not the native interfaces. Test accessibility, keyboard navigation, Dynamic Type, responsiveness and VoiceOver on the supported platforms. Apply the requested Impeccable review to the finished native designs as well as the web UI.

Provide two clearly identified macOS distribution editions with distinct build configurations and identifiers as needed:

- **Backend-connected edition:** connect to an operator's Cloudflare Worker, reuse its D1/R2 records and feature controls, and authenticate individual users through that instance's explicitly configured mode. The owner's Entra-backed Access is one option. Investigate and verify a supported native flow for each offered mode, including token/session validation, renewal and revocation; do not embed an Access service token, auth secret or provider keys in the app. The personal iOS app also uses this backend-connected model.
- **Configurable/direct-provider edition:** connect directly to Telnyx and PostGrid using credentials entered by each user, with no dependency on the owner's Worker API. Keep provider secrets in Keychain, never in source, app bundles, logs, crash reports or ordinary preferences. Use least-privilege credentials where providers offer them; explain that a local client credential can be extracted by someone controlling that device. Keep records and downloaded artifacts in protected local storage, document backup/export and deletion, and never upload them to the owner's backend. Investigate provider API, SDK and licensing compatibility with Swift and native WebRTC before promising feature parity.

Direct-provider mode has no always-on public webhook receiver simply because an app is installed. Determine which provider APIs can retrieve historical events, fax documents, voicemail and tracking while the app is running, and expose only verified capabilities. Incoming live calls, unattended event capture, reliable notifications, or provider webhook processing may require a separately hosted service or provider-supported mechanism. Show these limitations explicitly; do not claim offline or unattended delivery guarantees. Preserve the same proof-approval gate, idempotency safeguards, feature controls, and honest tracking semantics in both editions where supported. Block each direct-mode send until its provider support and safety, including reconciliation of ambiguous outcomes, are verified. Block shared-number setup until the specific account, number capabilities and routing, including independent inbound controls, are verified. Decide how direct-mode backups, synchronization and retention work before implementation.

Independently operated Cloudflare backends and secure native instance linking are intended; see [architecture](architecture.md) and [contracts](contracts.md). Native self-hosted authentication implementation and release are blocked pending verification and security review of a supported end-to-end flow, including issuer/audience trust and binding, redirects, renewal and session handling.

### Distribution and signing

Use the owner's paid Apple Developer account to upload personal iOS and, if desired, macOS builds to App Store Connect for internal TestFlight testing. An App Store release for the backend-connected instance-linking app is intended, subject to verified native authentication, platform requirements, review and separate release authorization; availability or approval is not assured. App Store distribution of the direct-provider edition is not assumed. Prefer Xcode's TestFlight Internal Only distribution when compatible with the intended audience. TestFlight builds expire after 90 days and need replacement; Apple processing and account setup are still required. Prepare two direct macOS downloads, each Developer ID-signed with hardened runtime, notarized by Apple, stapled where applicable, and verified with Gatekeeper before publishing. Document versioning, checksums, updates, provenance and recovery/revocation. Confirm Apple account permissions, certificates, bundle IDs, signing entitlements and signing-key custody without exposing private keys. Keep signing and notarization credentials out of fork PR jobs; production releases require reviewed, explicitly authorized trusted workflows. macOS CI can use standard GitHub-hosted macOS runners for public-repository checks, subject to GitHub availability and billing rules; signing and distribution must remain isolated from untrusted code.

## Delivery sequence

1. Create the public repository with MIT licensing, Conventional Commits, PR guidance and protected main; establish a non-main development branch.
2. Scaffold current stable Astro and Starwind UI, configure reproducible dependencies, accessible minimal layouts, synthetic fixtures and unprivileged CI.
3. Add reviewed infrastructure and explicitly configured instance authentication and authorization; validate them before deploying any sensitive functionality.
4. Build document storage, jobs, feature controls and authorization; add provider integrations with mocked tests and sandbox verification.
5. Verify proof approval, status mapping, idempotency, webhook signatures, media access, failure recovery and multi-channel partial success. Test responsive and accessible UI, then perform the requested Impeccable design review.
6. Configure production secrets through the approved custody path, set up Workers Builds, deploy through reviewed changes, and perform end-to-end checks with explicit authorization for any billable provider actions.
7. Implement and verify the native apps and both macOS editions; set up internal TestFlight and produce signed, notarized downloads after the required Apple account and provider capabilities are verified.

## Open decisions

- Confirm Telnyx and PostGrid account capabilities, sandbox access, webhooks, phone numbers and exact credential provisioning. Never place credentials in source or issue comments.
- Confirm data retention, backup and restore objectives, recording consent obligations, and who may change settings or send paid communications.
- Verify PostGrid's draft proof and release behavior, supported mail classes, return-receipt artifacts and provider-specific tracking for each intended destination.
- Confirm the webhook hostname and ensure it cannot bypass the configured authentication for app endpoints. The owner's existing Access policy trusts Entra; the owner confirms that connection is tenant-restricted. Verify Zero Trust deployment and, if needed, Better Auth compatibility, bootstrap and secret handling independently.
- Confirm minimum iOS/macOS versions, native app bundle identifiers, update distribution, and which native editions should be included in personal TestFlight testing.
- Verify native authentication for each offered mode and provider APIs/SDKs, direct-mode inbound and historical data capabilities, and whether an optional user-operated webhook service is needed for full parity.
