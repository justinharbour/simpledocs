# Inbound fax intake (not enabled or deployed)

Migration sequencing: PR #36 owns `0004_mail_intents.sql`,
`0005_mail_unresolved_actor.sql`, and the acknowledgement migration planned for
`0006_mail_acknowledgement.sql`; this feature uses `0007_inbound_fax_events.sql`.
At mail head `84a368c`, acknowledgement is still named `0008`, so its shift to
`0006` must be confirmed before integration. Voice's shift to `0008` is pending.
Merge mail into `develop` first, integrate it into this branch, then validate
migrations 0001–0007 in order before considering
this PR for merge or any separately authorized database upgrade. Renumbering
does not apply a migration or change an existing database.

### Expired-media recovery design gap

The [Telnyx refresh action](https://developers.telnyx.com/api-reference/programmable-fax-commands/refresh-a-fax)
documents `POST /faxes/{id}/actions/refresh` and a `{ "data": { "result": "ok" } }`
acknowledgement, not a replacement media URL. Do not treat that acknowledgement
as a recovered fax. Before enabling intake, verify with Telnyx how refreshed media
is delivered and its retention limits. A durable recovery implementation needs
to record the verified event ID, fax ID and timestamps before attempting media
retrieval, preserve pending state across crashes, and independently retry or
alert until the PDF is stored and linked. It must never persist signed URLs or
acknowledge a received event as complete solely because refresh succeeded.
The current handler does not persist failed download attempts; webhook retries
alone are not a durable recovery mechanism.

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
