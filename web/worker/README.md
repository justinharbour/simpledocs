# Owner Worker draft

## Send, calls and records (current)

All routes need a verified Cloudflare Access JWT. Telnyx webhooks are verified by
their Ed25519 signature instead.

| Route | Purpose |
| --- | --- |
| `POST /api/transmissions` | Multipart ordered PDFs and `spec` JSON. Prepares the numbered envelope and recipient-specific fax packets; every delivery awaits approval and nothing is queued. Returns 202. |
| `GET /api/transmissions/:id/fax/:deliveryId/review` | Actor-scoped review with recipient, sender, SHA-256, proof URL and review hash. |
| `GET /api/transmissions/:id/packet/:deliveryId` | Exact stored PDF submitted for this fax. |
| `POST /api/transmissions/:id/fax/:deliveryId/approve` | Same-origin JSON `{ "confirmed": true, "reviewHash": "..." }`; queues only this fax after verifying its stored proof and sender. |

New clients should upload `preparedDocuments` or `preparedNumberedDocuments` so older Workers reject preparation instead of sending prematurely. Legacy upload fields remain accepted but now prepare rather than queue faxes; older clients must be updated to review and approve them. Set optional `FAX_ESTIMATE_USD_PER_PAGE` to a nonnegative USD rate (up to six decimals) for a self-hosted instance; otherwise the UI labels the November 2026 published Telnyx list rate. This estimates the fax page-fee component only, not SIP usage, destination charges, retries, taxes, or the total. Mail cost is unavailable.
| `GET /api/recipients` | Recent fax and mailing recipients derived from the authenticated actor's last 200 dispatches. No separate address book or migration is required; deleting the underlying records removes them from this history. |
| `GET /api/transmissions`, `GET /api/transmissions/:id` | List, and detail with per-channel status and timeline. The UI polls the detail. |
| `GET /api/transmissions/:id/document` | The stored PDF. |
| `GET .../mail/:deliveryId/review?mode=test\|live`, `POST .../approve` | Paper mail is queued only after approval, bound to the review hash and the test or live PostGrid key. |
| `POST /api/cover-preview` | Fax cover page (pdf-lib) for the preview. The same generator is prepended to the document before Telnyx. |
| `GET /api/records` | Envelopes, inbound faxes and recordings, newest first. |
| `GET /api/voice/calls`, `GET /api/voice/recordings`, `POST /api/voice/recordings/:id/heard` | Call log and voicemail. |
| `POST /api/voice/presence` | Softphone heartbeat (`{online}`), about every 30 s while the page is connected. Stored under settings key `phone_online`; counts as online for 90 s. Voice owner only. |
| `GET /api/sms/threads`, `GET /api/sms/threads/:peer`, `POST /api/sms/threads/:peer/read` | SMS conversations derived from `sms_messages`, one thread per E.164 peer. Voice owner only. |
| `POST /api/sms/messages` | `{to, text}` (1 to 1600 characters). Writes a row, sends through Telnyx with an `Idempotency-Key`, and stores the provider id. A provider rejection returns 502 with the failed message. |
| `POST /api/webhooks/telnyx/messaging` | Signed Telnyx events: `message.received`, `message.sent`, `message.finalized`. Status only moves forward; delivered and failed are final. Outside Access (see `access-app.mjs`). |
| `GET /api/inbox?type=&filter=unread&limit=`, `GET /api/inbox/count` | Faxes, voicemail, missed calls and SMS threads merged newest first, and unread counts by kind. Fax items follow the inbound-fax allow list, voice and SMS the voice owner. |
| `POST /api/inbox/:kind/:id/read`, `.../unread`, `POST /api/inbox/read-all[?kind=]` | Read state. Faxes and missed calls use `inbox_reads`, voicemail `heard_at`, SMS `read_at`. Existing items start unread; use "Mark all read" once. |
| `GET`/`PUT /api/settings` | Sender name and mail return address. |
| `GET`/`PUT /api/settings/voicemail` | Voicemail `{greeting, voice, service_level}` with effective defaults, stored in the `settings` table and read at call time. `VOICEMAIL_GREETING` is the fallback greeting; the default voice is `Telnyx.KokoroTTS.af`. |

Status is honest: `delivered` is only set from a provider-reported terminal
status. PostGrid `completed` is shown as "Completed by PostGrid". Provider
acceptance is `accepted`. An ambiguous provider outcome is `unknown` and is never
retried automatically.

### Queues and cron

- Producer binding `DELIVERIES` sends `{transmissionId, channel, deliveryId}`.
- Consumer `queue(batch, env)` in `index.mjs`: max batch 5, 5 retries with a 30 s
  delay, then the dead-letter queue. It is idempotent, retries transient errors,
  and marks permanent failures `failed` with a safe reason.
- Queue names: `simpledocs-deliveries-queue-prod`, dead-letter `simpledocs-dlq-queue-prod`.
- The `*/5 * * * *` cron re-polls open rows older than 3 minutes, re-enqueues
  stale queued rows, and fails rows older than 24 hours.

### Bindings and storage

- D1 `DB` (`simpledocs-d1-prod`). Apply migrations 0012 (transmissions, dispatches,
  calls, settings, timeline) and 0013 (voicemail transcripts).
- One R2 bucket, `FILES` (`simpledocs-r2-prod`). Key prefixes: `inbound-fax/`,
  `voice/`, `outbound/<transmissionId>/`, `covers/<transmissionId>/`.
- `POSTGRID_TEST_KEY` and `POSTGRID_LIVE_KEY` select the test or live PostGrid key.
  The test key never mails anything.

### Voicemail transcription

The voicemail `record_start` command asks Telnyx to transcribe (`transcription: true`,
engine `A`, `en-US`). The `call.recording.transcription.saved` webhook stores the
text in `voice_transcripts` and copies it to `voice_recordings.transcript` once the
recording exists, in either event order. Duplicates are ignored. Telnyx sends no
confidence score on this event, so none is stored. There is no voicemail alert
email in this repository, so the transcript is not emailed.

## Earlier foundation notes

Build the deployable files with `pnpm install --frozen-lockfile`, `pnpm build`,
and `pnpm build:worker` from `web/`. The resulting static directory is `dist/`
and the single Worker module is `build/worker/index.js`. These outputs are not
an authorization to deploy; record and verify their digests against the reviewed
source and keep them unchanged between infrastructure plan and apply.

This is a protected draft, not a production-ready application. The repository
contains D1, R2 and queue bindings and provider-action code; it does not provision them. Access configuration and infrastructure ownership
must be reviewed and verified. Every request runs through the Worker; missing or
invalid Access assertions fail closed. Configure `ACCESS_TEAM_DOMAIN` as the
exact HTTPS Cloudflare Access team origin and `ACCESS_AUDIENCE` as the Access
application audience. The infrastructure must attach the approved Access
policy and independently protect the hostname. Do not enable workers.dev or
preview URLs without testing the same authentication boundary.

The mail-draft API uses the verified Access subject and a `DB` D1 binding. It
returns 503 without that binding. Tests include Miniflare's local D1 binding,
but not deployed D1 or live security testing. Writes require a
same-origin JSON request, bounded body, and a current revision.

The owner clarified that a locally generated review is acceptable instead of a
provider-generated preview. The draft mail API now provides review, send, and
status routes for a narrow US text-letter format. Review returns the exact
PostGrid request payload and a revision-bound hash; it is not a visual proof of
PostGrid's output. An authenticated same-origin confirmation claims the draft
once before the paid call. `MAIL_ENABLED=true` and the server-only
`POSTGRID_API_KEY` are required; both are absent by default. `submitting` after a
crash and `unknown` require manual provider reconciliation, never automatic retry.
Unresolved orders are listed by authenticated actor across devices. A partial
unique index blocks that actor from claiming any other order while one is
`submitting`, `unknown`, or accepted but not explicitly acknowledged. An
authenticated actor can acknowledge their accepted order after seeing its
provider ID; this is not evidence of delivery. Braces and
ampersands are rejected in letter text until provider template parsing and entity
decoding behavior is verified. Do not deploy this sender without migrations 0005 and 0006.
The mail UI saves and reviews a draft and displays the exact request before
confirmation; no live deployment or provider test is authorized by this
code. Before production validate account capabilities, migration, Access, UI
review usability, pricing and operator reconciliation. Never expose the API key.

## Reconciliation (operator)

`submitting` and `unknown` both mean an order may have been created. Never
reset the claim, retry the POST, or create a replacement until the outcome is
established independently. Preserve the draft ID, actor, review hash, payload,
confirmation time and status as sensitive records; do not put their contents or
credentials in tickets or logs. A `submitting` row may mean a crash before or
after invocation; absence of a recorded provider ID proves neither.

Using the correct PostGrid account and environment, inspect the provider's
dashboard or read-only order listing around the confirmation time. Correlate
`metadata.simpledocsDraftId`, recipient, sender, contents, options and timestamp;
if an ID is known, inspect that exact order. Use only authorized personnel and
minimum necessary access. Metadata search availability and completeness are not
verified; a missing search result is not proof no order exists. If ambiguous,
contact PostGrid support and preserve evidence. Record the provider ID and
evidence in the approved restricted operational record. Provider acceptance is
not delivery. This foundation has no reconciliation-write endpoint: do not
alter database state manually or remove claims as a workaround. A separate,
reviewed reconciliation feature and explicit owner authorization are required
before deciding how to resolve or replace an order.

## Provider schema review

On 2026-11-17 the PostGrid Print & Mail API reference was inspected read-only:
`POST https://api.postgrid.com/print-mail/v1/letters` accepts JSON and the
`X-API-Key` header. `LetterCreateWithHTML` requires `to`, `from`, and `html`;
inline first-name contacts require `firstName`, `addressLine1`, and
`countryCode`. The submitted fields and enums (`first_class`, `standard_class`,
`us_letter`, `standard` paper and envelope, `insert_blank_page`, boolean color
and double-sided, and metadata) occur in the current schema. See
https://docs.postgrid.com/ and recheck before release. This is schema inspection,
not provider execution, address validation, a rendering guarantee, or proof that
the intended account supports every choice. No live or sandbox order was made.

### SMS and ring-then-voicemail

`SMS_NUMBER` (wrangler var, `+12134587846`) is the sending and receiving number. Sending reuses `TELNYX_API_TOKEN`; the messaging webhook reuses `TELNYX_PUBLIC_KEY`. The number needs a Telnyx messaging profile, 10DLC registration, and the webhook URL `https://simpledocs.justinharbour.dev/api/webhooks/telnyx/messaging`. MMS is not handled; a media message is stored as "(media message not shown)".

When the softphone page is online and `TELNYX_WEBRTC_CREDENTIAL_ID` is set, an incoming call to `VOICEMAIL_NUMBER` is first transferred to the softphone (`sip:<sip_username>@sip.telnyx.com`, 20 s). If that leg ends without an answer, voicemail answers the original call. A rejected transfer or failed credential lookup answers voicemail at once; an unknown outcome waits and is never retried. Migrations: `0014_sms`, `0015_inbox_reads`, `0016_voicemail_rings`.
