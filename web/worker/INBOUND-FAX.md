# Inbound fax intake (not enabled or deployed)

The exact `/webhooks/telnyx/fax` path is outside interactive Access in the
Worker and uses Telnyx Ed25519 signatures over timestamp and exact raw bytes,
with a five-minute window. It fails closed unless the `TELNYX_INBOUND_FAX_ENABLED`
string is `true`, `TELNYX_PUBLIC_KEY`, `TELNYX_FAX_CONNECTION_ID`,
`TELNYX_FAX_NUMBER`, D1 `DB`, and private R2 `FAX_MEDIA` are configured. No
bindings or enablement are added here. Other routes still require Access; an
external Access policy must separately allow this exact webhook path without
opening app routes. Verify this boundary in the deployed environment.

Inbox rows store minimal identifiers and event metadata, not callback bodies,
media URLs or phone numbers. `fax.received` gets its PDF from the specific
`https://s3.amazonaws.com/faxes-prod/` origin shown in Telnyx's example, with
no redirects, and saves to R2 before the D1 event insert and HTTP 200. D1 and R2
are not transactional: failures and concurrent duplicates may leave private
orphan objects. PDF keys include the content hash, so competing deliveries
cannot replace the object referenced by the winning event row. A missing or expired URL, storage failure, or unsupported
host returns 503 so Telnyx can retry. Telnyx documents ten-minute URL expiry and
[a refresh action](https://developers.telnyx.com/api-reference/programmable-fax-commands/refresh-a-fax),
but refresh/reconciliation is not implemented; alert and provide an operator
recovery procedure before routing traffic. Telnyx may send duplicate and
out-of-order events; event IDs deduplicate without modifying delivery state.

Telnyx's [fax reception guide](https://developers.telnyx.com/docs/programmable-fax/receive-a-fax-api)
gives one example URL, not a contractual exhaustive list of media hosts. Confirm
the actual account's hosts before enabling; do not expand to broad AWS hostnames.
The handler accepts only inbound fax lifecycle events from the configured fax
connection and number. The same fax application may send outbound events to
the same webhook: these are currently rejected and outbound event reconciliation
must be added before using this endpoint for outbound fax. No retention policy,
orphan cleanup, alerts, key rotation, queue, or fax
refresh flow is provided. Private R2 policy and encryption, access, backup and
restore require independent verification. Protect D1 and R2 as sensitive data.

Authenticated retrieval is available at `GET /api/inbound-faxes` (most recent
100 received records) and `GET /api/inbound-faxes/{event-id}/pdf`. Both require
a verified Access assertion and membership of the exact JWT `sub` in the JSON
array `INBOUND_FAX_ALLOWED_SUBJECTS`. Configure this shared-inbox allowlist only
for users authorized to read every fax in the instance; it is not per-user
fax ownership. Missing or malformed configuration denies access. PDFs are
served as no-store attachments, never via public R2 URLs. List pagination,
per-user access control, caller metadata and fax management UI are not provided.

The [common webhook documentation](https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks)
requires raw-body signature verification and describes duplicate and out-of-order
delivery. Confirm actual signed fax events and replay behavior with a non-live
integration before release. No provider payload, signed URL, document or error
is intentionally logged. This code is not proof of readiness for production.
