# Proposed integration contracts

**Status: design proposal, v1; not implemented or provider-verified.** These shapes coordinate future work, not a promise of currently available APIs. The [architecture](architecture.md) describes trust boundaries; provider-specific feasibility and native authentication remain open. Before implementation, validate provider APIs, resource limits and the exact authentication flows. No sample below is a real credential or provider payload.

## Versioning and common rules

- Proposed backend base path: `/api/v1`. JSON uses UTF-8 and `Content-Type: application/json`; timestamps are RFC 3339 UTC strings and IDs are opaque strings. Clients must not infer order or ownership from IDs.
- Additive optional fields and new enum values may appear within v1. Clients ignore unknown fields and display unknown statuses without treating them as success. Removing or changing meanings requires a new major version and migration/deprecation plan. These rules apply once the API is published, not as a claim of current deployment.
- Proposed error envelope: `{ "error": { "code": "feature_disabled", "message": "This feature is disabled.", "requestId": "opaque" } }`. Return safe messages without credentials, document contents or raw provider errors. Use 400 for malformed input, 401 for missing/invalid authentication, 403 for denied access or disabled capability, 404 for unavailable resources without disclosing their existence, 409 for conflicts, 429 for rate limiting and 5xx for service failures. A 5xx or timeout does not prove a provider send failed.
- All resource operations require actor authorization, including artifact downloads and status reads. List responses must be bounded and use opaque cursors; size limits and retention are pending. Private artifacts are streamed through authenticated endpoints, with content-type and download protections; no permanent public R2 URLs.

## Proposed domain model

| Record | Minimum conceptual fields | Invariants |
| --- | --- | --- |
| Document revision | `id`, `documentId`, `contentHash`, `objectRef`, `createdAt` | Immutable bytes and digest; object reference is internal, never a public URL |
| Job | `id`, `createdBy`, `createdAt`, `deliveries[]` | Parent groups independent deliveries; no implicit all-channel retry |
| Delivery | `id`, `jobId`, `channel` (`fax` or `mail`), `revision`, `state`, `providerRef?`, `rawProviderStatus?`, `updatedAt` | A revision freezes recipient, document digest and channel-specific options; each channel has independent send and retry state |
| Proof | `id`, `deliveryId`, `revision`, `inputHash`, `proofHash`, `objectRef`, `source`, `createdAt` | Immutable, provider-generated for mail; input digest uses canonical serialization with a versioned algorithm including recipient, content and all print options |
| Approval | `deliveryId`, `revision`, `proofId`, `inputHash`, `proofHash`, `actorId`, `approvedAt` | Explicit actor action; valid only for the exact current revision and matching hashes; any send-relevant change invalidates it |
| Provider event | `provider`, `eventId`, `receivedAt`, `providerOccurredAt?`, `verification`, `processingState` | Authenticated, deduplicated inbox record; map raw status separately and apply transitions safely despite reordering |
| Audit event | `actor`, `action`, `target`, `outcome`, `time`, `requestId` | Minimal metadata; no secret, document or unnecessary personal data |

Hash algorithm, canonicalization, maximum sizes and schema migrations must be specified and tested before proofs are enabled. Mail requires a provider-rendered 1:1 proof for the exact send and a verified safe provider-supported approval and release path before any live send; an app-rendered preview is never an equivalent substitute. A proof is approval evidence, not delivery evidence. Record delivery evidence separately, with provenance. Provider artifact metadata may include tracking, carrier/IMB, receipt and provenance only when actually available. Evidence of order acceptance, processing or estimated completion is not evidence of delivery.

## API surface (proposed)

These are resource boundaries, not a complete schema or an implementation mandate. Authentication, authorization, validation and feature checks apply to every relevant operation.

| Operation | Proposed route | Contract |
| --- | --- | --- |
| Discover capabilities | `GET /api/v1/capabilities` | Return per-feature enabled/available state and a safe reason; never expose secrets. Informational only, not a grant to send. |
| Create and inspect jobs | `POST /api/v1/jobs`, `GET /api/v1/jobs/{id}` | Create a draft with independent deliveries; reads include per-channel state and partial outcomes. No provider send on creation. |
| Change delivery draft | `PATCH /api/v1/jobs/{jobId}/deliveries/{deliveryId}` | Optimistic revision precondition; a send-relevant change creates a new revision and invalidates approval. Reject edits racing an in-flight submission. |
| Request and approve proof | `POST /api/v1/jobs/{jobId}/deliveries/{deliveryId}/proofs`, `POST /api/v1/jobs/{jobId}/deliveries/{deliveryId}/approvals` | Proof generation must not create a paid order. Approve explicit proof ID and expected revision/hashes, atomically checking they still match. Unsupported proof flow fails closed. |
| Submit a delivery | `POST /api/v1/jobs/{jobId}/deliveries/{deliveryId}/submit` | Require expected revision and `Idempotency-Key`; recheck actor, capability and approval atomically with intent. Accepted means queued/recorded, not delivered. |
| Read artifact | `GET /api/v1/artifacts/{id}` | Authorize and stream the specific artifact; do not expose object storage references. |

Exact document upload, voice session, settings, pagination and webhook route schemas are deliberately deferred. Voice must use short-lived least-privilege credentials only if the provider and native/browser flows support them; no provider master credential reaches a client.

## State, retries and idempotency

Proposed delivery states: `draft`, `awaiting_proof`, `awaiting_approval`, `ready`, `queued`, `submitting`, `submitted`, `in_progress`, `delivered`, `failed`, `cancelled`, `unknown`. Not all channels support all states. `delivered` requires provider evidence with that meaning; preserve original status and timestamps. `unknown` means outcome cannot safely be inferred, and is not a failure warranting resend. Define provider mappings and allowed transitions, including terminal correction and late events, with tests before integration. Parent status is derived from deliveries and must identify partial success rather than collapsing it into success.

For each submit, the client generates a high-entropy idempotency key and reuses it for retries of the same intent. Scope it to authenticated actor, operation and delivery; persist a canonical request fingerprint, revision, result and expiry. Atomically reserve before side effects: same key and fingerprint returns the stored result or current in-progress state; same key with different inputs returns 409. Concurrent distinct keys must not create duplicate submissions for the same delivery revision. Retention must cover retry and reconciliation windows and be decided before launch. Never log the key as a credential or assume local deduplication prevents duplicate provider charges after a crash. Where provider idempotency is documented, use a stable per-delivery key under its required scope and retention; otherwise reconcile uncertain results or require manual review. A deliberate new send is a new delivery/intent, not a replay of a successful one.

## Webhooks and feature flags

Webhook endpoints are a separate public ingress with no interactive Access dependency. Verify the signature over the exact raw request bytes using the provider's documented algorithm, keys and signed fields; validate timestamp/freshness where supported, bound request size, and support key rotation. Do not parse and reserialize before verification. Persist a verified event and deduplication identity before returning success; duplicate verified deliveries are acknowledged without repeating side effects. If a provider lacks a stable event ID or signed timestamp, determine a documented safe deduplication/replay strategy before enabling it. Respond non-success on verification or durable storage failure. Treat queue and webhook deliveries as at least once; reconcile missing, duplicate and out-of-order events without state regression. Do not expose a generic unauthenticated callback.

Proposed flag identifiers: `fax.outbound`, `fax.inbound`, `voice.outbound`, `voice.inbound`, `voice.voicemail`, `mail.outbound`. Default false; changes require authorized administration and an audit event. Actual availability also depends on configuration, account permissions, routing and verified provider support. Check at intake and again at dispatch; disabling does not cancel a provider-accepted send or change number routing. Webhooks still need authenticated ingestion and reconciliation for previously accepted work when a sending flag is off.

## Cross-edition compatibility

Backend-connected iOS/macOS clients consume the same v1 domain semantics after native Access authentication is verified. They may connect to independently operated instances; no instance receives another instance's session or data. Direct-provider macOS shares domain concepts and the proof/idempotency safety requirements, not an assumption that the Worker API or server flags exist locally. Its own protected storage and provider adapters must explicitly represent missing capabilities. It must not send credentials or artifacts to the owner's backend. If the provider cannot safely offer proof, deduplication or reconciliation in direct mode, block the affected operation rather than advertise parity.

## Instance onboarding and provisioning (proposed)

- A deployment is an operator-controlled instance, not a tenant in an assumed shared service. It owns its configured identity trust, user authorization, data, provider credentials and operational policy. Supporting multiple users in one instance does not establish isolation between independent tenants. Shared hosting and tenant-scoped administration require a separate design.
- A Cloudflare Deploy button is the intended bootstrap path, subject to feasibility and security review. Provisioning inputs and outputs, required permissions, cost disclosure, resource ownership, infrastructure state and upgrades are not yet specified. Provision through reviewed infrastructure-as-code; no secrets in buttons, URLs, templates, source, public logs or native binaries. Use the operator's secure runtime secret mechanism and default live capabilities off. Validate privacy, Access and webhook authentication before activation.
- A user explicitly enters and confirms the instance's HTTPS origin. A future discovery document may advertise API version, instance identifier and authentication configuration, but its route, schema, authenticity and binding to the selected origin and trusted issuer/audience are **undecided**. Discovery alone must not establish identity trust or authorize an arbitrary issuer. Verify TLS and origin, present meaningful identity information for confirmation, and reject untrusted origin changes, insecure redirects and token forwarding to unrelated origins. Exact trusted issuer onboarding and redirects require review before implementation.
- A native client uses a verified, instance-specific interactive authentication flow and validates applicable issuer, audience and session properties; no embedded Access service token, provider secret or shared privileged credential. Store sessions in Keychain scoped to the instance and identity, isolate caches, and support unlink/local token removal. Never reuse credentials, idempotency keys or cached records across instances. Revocation and renewal semantics depend on the selected verified identity flow; unlinking locally does not by itself prove server-side revocation.
- Native self-hosted authentication implementation and release are blocked until a supported end-to-end flow has been verified and security-reviewed, including issuer/audience trust and binding, redirects, renewal and session handling. No speculative fallback is permitted.
- Before linking or sending, negotiate a supported API major version and recheck instance capability and actor authorization. Unknown versions, unavailable authentication, mismatched trust or disabled capabilities fail closed. Switching instances requires an explicit context and must not silently retarget an existing job or pending action.

An App Store release for backend-connected instance linking is intended, not yet approved or available. Platform-specific authentication, review, signing, release and policy requirements remain to be verified. Direct-provider macOS remains a separate edition; no App Store availability is implied for it.

Direct-provider sending stays disabled per operation until provider support, safe proof where required, credential handling and duplicate-send prevention or reliable reconciliation are verified in that mode. Shared-number setup stays disabled until the intended account and number support the required voice/fax capabilities and routing, including independent inbound controls; existing routing must not be silently changed.
