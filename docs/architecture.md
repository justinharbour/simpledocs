# Architecture and trust boundaries

**Status: proposed, version 1.** This is a design contract for implementation, not a claim that endpoints, infrastructure, integrations or provider capabilities exist. [The plan](plan.md) governs delivery and unresolved feasibility; [the integration contract](contracts.md) defines the proposed wire and data shapes. Changes that break a published contract require a new version and migration plan.

## Boundaries

| Boundary | Responsibility | Trust rule |
| --- | --- | --- |
| Web | Static Astro UI; renders capability and job state | UI controls are not authorization or feature enforcement |
| Backend-connected native | Swift UI and shared domain code; same backend records and decisions as web | Authenticate as an individual; no embedded provider keys or Access service token |
| Worker API | Authenticate, authorize, validate, enforce flags and proof gates, own job transitions, mediate provider calls and private artifacts | Treat client input and provider responses as untrusted; never return runtime credentials |
| D1 | Configuration, job and delivery metadata, approvals, event inbox, audit and idempotency records | State changes need durable, conditional updates; no document bytes or provider secrets |
| Private R2 | Source documents, immutable proof versions and available provider artifacts | Authorize every read/write through the Worker; never expose public object URLs |
| Queue, if introduced | Durable asynchronous work and retry signals | At-least-once delivery is assumed; a queue is not an exactly-once or authorization boundary |
| Providers | External fax, voice and mail operations and events | Provider capabilities and status semantics are account- and product-dependent; independently authenticate webhooks |
| Direct-provider macOS | User-owned credentials, local records and direct provider requests; no owner's Worker dependency | Keychain for secrets, protected local artifacts, explicit local export/deletion; a device owner can extract local credentials |

Application routes are protected by the existing tenant-restricted Cloudflare Access/Entra policy. The Worker validates Access assertions, including issuer, audience, signature, expiry and the trusted identity, and separately authorizes the actor and operation. Cookie-authenticated mutations require origin validation and CSRF protection; do not accept a client-supplied identity or rely on CORS as authorization. Authorization roles, allowed origins, session lifecycle and native Access/OAuth flow remain to be designed and verified. Until then, sensitive operations stay disabled. Webhook routes are isolated from app routes and use provider authentication, not an Access bypass for application APIs.

## Workflow and persistence

A job groups a document and recipient intent; each selected channel has a separate delivery, approval where required, idempotency scope, provider reference, status and retry history. Changes to send-relevant inputs create a new immutable revision and invalidate the affected approval. A failed mail delivery never causes a successful fax delivery to be resent. Provider status and evidence are retained separately from normalized state; aggregate job state must expose partial success and uncertainty.

For physical mail, do not submit a live order until an explicit approval binds the exact recipient, content, print options and a provider-generated proof to the immutable revision. Verify a safe provider-rendered 1:1 proof and release path for the intended account first; ordinary post-order previews are not proof of a safe pre-send gate. If unavailable or ambiguous, live mail is blocked. Fax approval requirements and artifact availability must be confirmed before their flows are enabled.

Webhook acceptance requires signature and freshness checks according to the provider's actual specification, then durable inbox persistence before success is acknowledged. Deduplicate provider events, process asynchronously and tolerate duplicates and reordering. Reject invalid requests; fail closed when verification or durable acceptance is unavailable. Event IDs, timestamp windows, key rotation and reconciliation depend on provider documentation and must be verified, not invented. A queue may wake workers, but the durable inbox and delivery records remain the source of truth.

External sends cannot be made atomic with a D1 transaction. Persist intent before the call; use provider idempotency only where documented and verified. An ambiguous timeout becomes an unknown outcome requiring provider reconciliation or manual review, not an automatic resend. Retrying a paid operation is safe only when its provider's deduplication or a reliable reconciliation path has been demonstrated. Enforce this independently for each channel, including direct mode.

## Capability controls and operations

Default all live provider operations off. Server-side flags separately gate outbound fax, inbound fax, outbound voice, inbound voice, voicemail and outbound mail. Evaluate authorization, configuration, provider/account capability and flag at the operation boundary, including asynchronous dispatch; a UI hint or a previously queued job is not permission to send after a flag is disabled. Disabling a feature does not imply that provider routing has changed or that already accepted work was cancelled. Direct mode applies equivalent local gates but cannot enforce policy against a user controlling their device.

Infrastructure, secrets and deployments follow the reviewed OpenTofu and runtime-secret path in the plan. Retention, backup and restore, consent for recordings, audit access, provider credential rotation and operational alert thresholds require owner decisions before production. Logs and audit events must exclude credentials, document contents, webhook bodies and unnecessary personal data. Never use live paid operations as routine tests without explicit authorization.

## Native capability boundary

Backend-connected clients use the same versioned API and server decisions as the web, subject to a verified native Access authentication and renewal flow. Direct-provider mode has no owner's backend and no always-on webhook receiver merely because the app is installed. Historical retrieval, live inbound calls, notification, provider SDK licensing, native WebRTC and reliable offline/unattended behavior are unverified. Show only verified capabilities, and explicitly disclose limitations. A separately operated service or provider mechanism may be needed; do not promise parity or silent synchronization. Local backup, retention and multi-device behavior remain open.
