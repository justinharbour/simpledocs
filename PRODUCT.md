# Product

<!-- impeccable:product-schema 1 -->

## Platform
web, iOS and macOS

## Stack
Astro static frontend on Cloudflare Workers, Starwind UI, D1 and R2; Cloudflare Queues where useful. Telnyx powers fax and voice, PostGrid powers physical mail. Cloudflare Workers Builds deploys from GitHub.

Native iOS and macOS apps use Swift. The owner's app connects to the Cloudflare backend; a separate downloadable macOS edition connects directly to providers with user-supplied credentials, without requiring the owner's Worker API. Native apps follow platform conventions; Starwind UI is for the web.

## Users
Authorized users of independently operated instances need to send and receive communications and find their records. The owner's existing tenant-restricted Entra connection is one identity option, not a requirement for every instance.

## Product Purpose
Provide a simple, minimal communications workspace for fax, phone, voicemail and paper mail with durable records and proofs.

## Capabilities and Constraints
- Individual features can be disabled; a single number can be shared where provider capabilities permit, with inbound voice or fax individually disabled.
- Store metadata in D1 and documents, proofs, and attachments in R2. Support sending a document through multiple channels and independently track each delivery.
- PostGrid mail classes, tracking and return receipt depend on provider and destination availability. Require a provider-generated proof and explicit approval before sending.
- Public portfolio repository, permissive license, conventional commits, pull requests instead of direct commits to main. Welcome contributions.
- Prefer Cloudflare Zero Trust alongside Deploy to Cloudflare; if that is not feasible, consider explicitly configured Better Auth with environment secrets. Authentication is independently configured and verified per instance; the owner's Entra-backed Access remains an option. Provider webhooks require independent authentication and cannot depend on interactive login.
- Personal iOS and macOS testing uses TestFlight. An App Store release is intended for the backend-connected app, including linking independently operated instances, subject to verified native authentication and platform review. Two signed downloadable macOS editions are also planned: provider-configurable and backend-connected. App Store availability for the direct-provider edition is not assumed.

## Brand Commitments
Name: simpledocs. Extremely minimal and simple interface. Use Starwind UI.
