# Implementation plan

This is a design and delivery plan, not a statement that functionality exists.

## Architecture

Build an Astro static interface using Starwind UI and a Worker API. Keep application data and all API mutations behind the existing Cloudflare Access Entra policy, with validated Access assertions and CSRF protections. Expose provider webhook endpoints separately from interactive Access, authenticate them using each provider's documented signature mechanism, and reject stale or replayed requests. Do not enable an unauthenticated fallback if verification is not supported or configured.

Use D1 for configuration, communication jobs, channel deliveries, audit events, provider IDs, statuses and metadata. Use private R2 objects for source documents, generated proofs, fax artifacts and voicemail. Serve objects only through authorized endpoints. Introduce `simpledocs-queue-prod` if necessary for reliable webhook processing, retries and asynchronous provider work; acknowledge events only after durable acceptance. Model duplicate and out-of-order events and use idempotency keys to avoid duplicate paid sends.

Provision infrastructure through reviewed OpenTofu modules and stacks, not unmanaged dashboard resources. Target `simpledocs-wkr-prod`, `simpledocs-d1-prod`, `simpledocs-r2-prod`, and `simpledocs.justinharbour.dev`; isolate webhook routing appropriately. Validate DNS ownership, permissions, encryption, data retention, recovery and backup procedures before production. Cloudflare Workers Builds deploys from Git; GitHub Actions uses standard hosted runners for checks only. Never expose secrets to untrusted PRs. GitHub Actions secrets are not available to Workers at runtime: supply provider credentials as Cloudflare runtime secrets or secret-store bindings. Prefer federation when supported.

## Fax and voice

Integrate the current Telnyx SDK and browser WebRTC SDK with short-lived, least-privilege credentials. Securely receive and archive fax documents and delivery confirmations. Implement outbound and inbound calls, call-state transitions, disconnect/error handling, and voicemail with private recording storage. Individually gate outbound fax, inbound fax, outbound voice, inbound voice and voicemail on the server, not just in the interface. Validate Telnyx account and number capabilities and routing before presenting a shared-number setup as available; do not silently change provider routing.

## Paper mail and multi-channel delivery

Use PostGrid's supported mailing-class values without claiming a class, return receipt, or tracking exists for every destination or product. Capture class, extra services, provider IDs, status changes, tracking number and carrier/IMB details when available. Preserve raw provider status separately from normalized status; never label an estimated completion as confirmed delivery. Save provider-generated proofs, receipts and artifacts when available.

An approved proof must correspond to the exact recipient, contents and print options being sent. Investigate PostGrid's draft campaign preview flow and verify with the intended account whether it provides a safe, provider-rendered 1:1 approval before committing an order. Freeze and hash approved inputs and proof; invalidate approval on change. If a safe proof-and-release path cannot be verified, block live sending rather than presenting an approximation as a guarantee. Ordinary letter previews are generated after order creation, which can initiate a paid, time-sensitive order.

Create a parent job with independent fax and mail deliveries, each with its own approval, idempotency key, status, provider reference and failure/retry state. Make partial successes explicit; never automatically resend a successful channel when another fails.

## Delivery sequence

1. Create the public repository with MIT licensing, Conventional Commits, PR guidance and protected main; establish a non-main development branch.
2. Scaffold current stable Astro and Starwind UI, configure reproducible dependencies, accessible minimal layouts, synthetic fixtures and unprivileged CI.
3. Add reviewed infrastructure and Access protection; validate it before deploying any sensitive functionality.
4. Build document storage, jobs, feature controls and authorization; add provider integrations with mocked tests and sandbox verification.
5. Verify proof approval, status mapping, idempotency, webhook signatures, media access, failure recovery and multi-channel partial success. Test responsive and accessible UI, then perform the requested Impeccable design review.
6. Configure production secrets through the approved custody path, set up Workers Builds, deploy through reviewed changes, and perform end-to-end checks with explicit authorization for any billable provider actions.

## Open decisions

- Confirm Telnyx and PostGrid account capabilities, sandbox access, webhooks, phone numbers and exact credential provisioning. Never place credentials in source or issue comments.
- Confirm data retention, backup and restore objectives, recording consent obligations, and who may change settings or send paid communications.
- Verify PostGrid's draft proof and release behavior, supported mail classes, return-receipt artifacts and provider-specific tracking for each intended destination.
- Confirm the webhook hostname and ensure it cannot bypass Access for app endpoints. The existing Access policy trusts the Entra login method; the owner confirms the Entra connection is tenant-restricted.
