# Telnyx adapter boundary (provisional)

This folder is an **unintegrated adapter**, not a working product feature. It has no HTTP route, persistence, queue, provider API client, UI, infrastructure, or production configuration. Fax/voice events are normalized for a future caller; the caller must verify signatures before parsing, enforce request-size limits, atomically persist the event ID before acknowledging it, and apply safe out-of-order transitions.

Webhook verification follows Telnyx's documented `telnyx-signature-ed25519` and `telnyx-timestamp` headers: Ed25519 over the exact raw request bytes prefixed with `timestamp|`, using the account's base64-encoded signing public key. Freshness defaults to five minutes. Keys must come from trusted runtime configuration and be rotated per provider procedure. Do not bypass verification on missing configuration. Runtime support for WebCrypto Ed25519 must be verified in the eventual Worker deployment target.

Only the five fax and six voice event names currently listed by this adapter are accepted; unknown types are rejected. Status mapping is intentionally conservative and must be validated against event payloads and the product's transition rules. Event ID uniqueness is only represented as a key here: no durable idempotency is provided. No fax send, receive routing, calling, voicemail, number provisioning, or account capability is enabled by this module. All capability flags default to false.

Tests use locally generated ephemeral Ed25519 keys and synthetic payloads only. They do not contact Telnyx or perform paid operations.
