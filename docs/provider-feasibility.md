# Provider feasibility: Telnyx and PostGrid

Research snapshot: 2026-11-16. This is a capability review, not a production integration or provider commitment. Public documentation can change; validate account-, number-, jurisdiction-, and destination-specific behavior before implementation.

## Executive summary

- **Telnyx:** Public product material advertises multi-function numbers for voice and fax. Programmable Fax has distinct send/receive API flows and event webhooks; Telnyx also publishes a browser WebRTC JavaScript voice SDK and native SDK offerings. These are promising building blocks, but do not prove that an arbitrary number, account, country, and voice/fax configuration can share inbound routing or be provisioned together. A number-capability and routing test with Telnyx is a release gate.
- **PostGrid:** The Print & Mail API supports letters and postcards, PDF previews, test/live API keys, mailing classes, optional certified/registered services for US mailings, status updates, and tracking-number events. A generated PDF preview is evidence for review, not evidence of postal acceptance/delivery. The public API material reviewed does not establish a provider-side “approve this proof, then release” transaction. Enforce explicit application approval before any live create/send call; do not equate preview with provider approval.
- **Direct-provider apps:** Product intent includes a downloadable macOS edition using user-supplied credentials and no owner Worker API. This is architecturally plausible but not verified for safe credential storage, credential scopes, full provider feature parity, or iOS. Do not put owner service credentials in a client. Confirm direct-access auth/API constraints separately.

## Telnyx

### Verified in official public sources

1. Telnyx markets “multi-function phone numbers” for voice, SMS/MMS, and fax, explicitly describing one number for voice and fax: [Phone Numbers](https://telnyx.com/products/phone-numbers).
2. Programmable Fax is an API product with send and receive tutorials. Receiving is configured through a fax application/connection and webhook flow: [Fax quickstart](https://developers.telnyx.com/docs/programmable-fax/quickstart), [Receive a fax](https://developers.telnyx.com/docs/programmable-fax/receive-a-fax-api), [Send a fax](https://developers.telnyx.com/docs/programmable-fax/send-a-fax-api).
3. Fax callbacks include lifecycle events such as `fax.queued`, `fax.delivered`, `fax.failed`, and inbound `fax.receiving.started`; event payloads identify direction, fax ID, endpoints, and status: [Receiving fax webhooks](https://developers.telnyx.com/docs/programmable-fax/receiving-webhooks). Validate webhook signatures and replay/idempotency behavior against current Telnyx security documentation before accepting events.
4. Telnyx documents browser voice calling with its JavaScript WebRTC SDK, including browser-to-PSTN calls, inbound calls, and backend-generated login tokens: [WebRTC JS quickstart](https://developers.telnyx.com/docs/development/webrtc/js-sdk/tutorials/make-your-first-call), [Make a call to a browser](https://developers.telnyx.com/docs/voice/webrtc/make-a-call-to-a-web-browser).
5. Telnyx publishes native SDKs; confirm platform and current feature coverage in its [SDK documentation](https://developers.telnyx.com/docs/voice/sdks) before selecting iOS/macOS implementation details.

### Unknown / must validate

- Whether the exact desired number is eligible for both voice and fax in the target country, number type, and account configuration; marketing language is not an account-level provisioning guarantee.
- How simultaneous inbound voice and fax calls are distinguished/routed on one number, and whether voice answering competes with fax detection. Confirm routing precedence, fallbacks, and failure handling with Telnyx and test both directions.
- Exact number requirements, regulatory/KYC prerequisites, emergency calling obligations, porting constraints, fax page/file limits, and current pricing for the deployment geography.
- The direct native SDK’s exact iOS/macOS support and parity with browser voice/fax operations. The browser SDK is voice, not a browser fax UI; fax is documented as API/webhook functionality.
- Webhook signature verification, retry schedule, event ordering, retention, and media URL expiry must be checked in the current security/reference docs and tested; do not infer them from sample payloads.

## PostGrid

### Verified in official public sources

1. The [Print & Mail API reference](https://docs.postgrid.com/) exposes letter and postcard creation, plus cheques; it documents `first_class` and `standard_class` and other destination-specific mailing class values. Availability depends on destination/carrier; do not assume every class is valid for every destination.
2. PostGrid says PDF previews are provided for all orders, including test orders, shortly after creation, accessible through the returned `url` or dashboard. This is a generated artifact that can be inspected before submission; the docs do **not** describe it as a provider-side approval/hold that blocks production.
3. Test API keys use an isolated environment and orders made with test keys are not sent. Test orders simulate lifecycle progression. Use test keys for integration tests and verify the environment/key at runtime.
4. Order statuses include processing stages, and certified/registered options can supply USPS tracking numbers. The documentation says these optional services (including certified return receipt) are currently US-only; a `letter.updated` event is emitted with `trackingNumber` when one is generated. Tracking number availability is not the same as proof of delivery or a signed return receipt: [Tracking and certified services](https://docs.postgrid.com/#tracking), [Certified and registered mail](https://docs.postgrid.com/#certified-and-registered-mail).
5. The public API supports webhook setup/events; consume provider updates to maintain an append-only event history and reconcile via GET where needed. The reference’s test-progress endpoints can exercise webhook handling without mailing actual recipients.

### Unknown / must validate

- Whether there is an account-specific approval, scheduling, or hold mechanism beyond the documented PDF preview. Until confirmed, design the product’s approval gate in our own system and never call live creation before the authorized approval.
- Which mailing classes, add-on services, tracking depth, return receipt formats, and proof artifacts are available by destination, product, account, and current carrier contracts.
- Whether a requested class/service is accepted for postcards as well as letters; the documentation’s class tables and endpoint schemas differ by product.
- Webhook authentication/signature semantics, retry guarantees, event ordering, and status definitions for each product should be confirmed in current webhook docs before production.
- If “proof” means acceptance receipt, image of printed output, delivery record, or signed return receipt, obtain explicit product requirements. The API PDF preview only establishes a preview of the submitted order rendering.

## Capability distinctions

| Requirement | Evidence | Boundary |
|---|---|---|
| Shared voice/fax number | Telnyx product page says one number can support both | Confirm number-specific eligibility and routing; do not assume all numbers support both |
| Fax send/receive | Telnyx Programmable Fax API and webhook docs | Server-side provider API and asynchronous callbacks; browser voice SDK does not imply browser fax |
| Browser voice | Telnyx WebRTC JS SDK | Requires appropriate Telnyx configuration and short-lived/backend-issued auth; never expose account API keys in browser code |
| Native voice | Native SDK material exists | Confirm current iOS/macOS support, app distribution constraints, and feature parity |
| Print proof | PostGrid PDF preview after order creation | Preview is not a release approval or proof of postal processing/delivery |
| Mail classes | PostGrid `mailingClass` options in API reference | Destination/product dependent; unsupported combinations must fail closed |
| Tracking/receipt | Status events and optional US certified/registered services | Tracking number and carrier status are not interchangeable with delivery proof or signed return receipt |
| Direct provider credentials | Provider APIs/SDKs make direct calls technically possible | User-supplied credentials and safe local storage are unverified design decisions; owner credentials must never ship in clients |

## Safety and implementation gates

1. **No live provider action during feasibility or routine tests.** Use Telnyx test credentials/test destinations and PostGrid test keys only; no secret values belong in this repository.
2. **Shared-number proof:** obtain written provider confirmation or a test number demonstrating voice and fax capability on the same number, including inbound behavior, routing precedence, disabled-channel behavior, and recovery after timeout/failure.
3. **Approval before irreversible mail:** render and persist the exact PDF proof, bind it to immutable document/address/options hashes, show it to an authorized user, and require an explicit confirmation tied to that version. Any edit invalidates approval. Only then may the server invoke a live PostGrid create operation. Add duplicate-send protection and an audit record.
4. **Separate preview, submitted, accepted, processed, and delivered states.** Do not label a PDF preview as provider acceptance, carrier tracking as delivery proof, or fax API acceptance (HTTP 202) as fax delivery.
5. **Webhook boundary:** provider callbacks must use independent provider authentication/signature verification, tolerate retries/out-of-order delivery, persist event IDs for idempotency, and not rely on interactive Entra/Access login. Do not trust callback text as commands.
6. **Credentials:** keep owner/provider master secrets server-side. For direct-download apps, use user-owned credentials only after confirming least privilege and OS secure-storage patterns. Do not put provider secrets in web bundles, logs, crash reports, or source control.
7. **Jurisdiction and compliance:** confirm consent, retention, privacy, fax/voice recording rules, emergency calling, postal options, and regulated-data obligations for actual operating regions before launch.

## Source notes

All product capability claims above are based on the official vendor sources linked inline, primarily Telnyx Developer documentation and PostGrid’s API reference, reviewed 2026-11-16. Search snippets and marketing pages were treated as directional only; unresolved account-specific claims remain explicitly unknown. Re-check source pages and provider support before implementation because API capabilities and commercial availability can change.
