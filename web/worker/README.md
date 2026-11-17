# Owner Worker draft

Build the deployable files with `pnpm install --frozen-lockfile`, `pnpm build`,
and `pnpm build:worker` from `web/`. The resulting static directory is `dist/`
and the single Worker module is `build/worker/index.js`. These outputs are not
an authorization to deploy; record and verify their digests against the reviewed
source and keep them unchanged between infrastructure plan and apply.

This is a protected draft, not a production-ready application. The repository
contains D1 binding and provider-action foundations, but does not provision R2 or
implement provider webhooks. Access configuration and infrastructure ownership
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
decoding behavior is verified. Do not deploy this sender without migrations 0005 and 0008.
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
