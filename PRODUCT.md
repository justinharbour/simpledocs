# Product

<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
Astro static frontend on Cloudflare Workers, Starwind UI, D1 and R2; Cloudflare Queues where useful. Telnyx powers fax and voice, PostGrid powers physical mail. Cloudflare Workers Builds deploys from GitHub.

## Users
Internal users authenticated through the existing tenant-restricted Entra connection need to send and receive communications and find their records.

## Product Purpose
Provide a simple, minimal communications workspace for fax, phone, voicemail and paper mail with durable records and proofs.

## Capabilities and Constraints
- Individual features can be disabled; a single number can be shared where provider capabilities permit, with inbound voice or fax individually disabled.
- Store metadata in D1 and documents, proofs, and attachments in R2. Support sending a document through multiple channels and independently track each delivery.
- PostGrid mail classes, tracking and return receipt depend on provider and destination availability. Require a provider-generated proof and explicit approval before sending.
- Public portfolio repository, permissive license, conventional commits, pull requests instead of direct commits to main. Welcome contributions.
- Access uses the existing Entra policy; provider webhooks require independent authentication and cannot depend on interactive Access login.

## Brand Commitments
Name: simpledocs. Extremely minimal and simple interface. Use Starwind UI.
