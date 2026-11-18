# Email portal draft: integration and rollout

This is an incomplete draft and has not been deployed or independently security reviewed.
The owner API can create an email delivery for an existing owner-authorized
transmission (`POST /api/transmissions/:id/email`, JSON `{email, pinChannel:
"none"|"sms"|"voice", phone?}`) and revoke it (`POST
/api/transmissions/:id/email/:deliveryId/revoke`). This is an independent record integrated with Send and transmission records.
The owner can select email and optional phone verification; the recipient must
consent before a message or call is initiated. There is no recovery/resend UI.

## Access and email evidence

`web/worker/access-app.mjs` provisions a host-wide owner Access application and
more-specific webhook bypass applications. Cloudflare documents [more-specific
path precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
and [public endpoint bypass](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/).
After review, provision separate exact-path bypass applications for `/portal`,
`/portal/exchange`, `/portal/status`, `/portal/pin/start`, `/portal/pin/check`,
and `/portal/document`; do not bypass `/api`, the owner app, or a broader
prefix. Verify actual deployed Access policy and path normalization, including
negative tests for owner APIs and adjacent paths, before enabling. No Access
application or provider configuration was changed by this work.

The existing `FAX_ALERT_EMAIL` binding sends operational alerts using the
Cloudflare Workers email API. The existing `send_email` binding has no explicit
recipient restrictions. [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)
documents arbitrary recipients on Workers Paid and a sender from an onboarded
Email Sending domain; verified destination addresses have a separate free path.
This does not establish current account onboarding, plan, quota, sender domain,
or deliverability. A new `PORTAL_EMAIL` binding and `PORTAL_SENDER` are needed;
acceptance is not delivery. The Wrangler configuration declares the binding; live account setup remains unverified.

Telnyx endpoint discovery and schemas identify `POST /v2/verifications/sms`,
`/v2/verifications/call` with `phone_number`, `verify_profile_id`, and optional
`timeout_secs`; `POST /v2/verifications/{id}/actions/verify` takes `code` and
returns `data.response_code` accepted or rejected. See [Telnyx Verify](https://developers.telnyx.com/api-reference/verify/trigger-sms-verification)
and [security best practices](https://developers.telnyx.com/docs/identity/verify/security-best-practices).
A suitably configured Verify profile, credentials, allowed destinations and
compliance review are required. No Telnyx API operation was invoked.

## Security properties and limitations

The invitation URL carries a 256-bit token in the fragment. An explicit click
exchanges its SHA-256 hash using an atomic D1 update, so GET and ordinary mail
link scanners do not consume it. A 30-minute host-only Secure, HttpOnly,
SameSite=Strict cookie authorizes only that delivery. Exact configured HTTPS
origin is required on mutations; expiry and revocation are checked on access.
The document copy is encrypted with AES-256-GCM and delivery/document-bound
associated data. This is **not end-to-end encryption**: the server has the key;
the existing source remains under the current R2 storage protections. Possession
of a forwarded link is sufficient without PIN. A PIN is optional per delivery;
when selected, an unchecked recipient consent checkbox precedes one Telnyx
request, a matching accepted PIN is required, and attempts are bounded. Provider
uncertainty is not retried automatically. Fixed-window D1 client, destination, global Verify,
and owner limits are basic controls, not comprehensive bot or SMS-pumping
protection; IP availability and upstream trust must be verified.

Remaining release work includes recipient-specific consent
and legal wording, stronger abuse protection and cost monitoring, retention policy for audit metadata and transactional orphan recovery, reliable atomic one-time exchange plus
session creation, token/session failure recovery, key rotation and backup,
security review, accessibility testing, and end-to-end deployment verification.
Provider timeouts are deliberately reported as unknown, not failures or delivery.
Current inline-script CSP needs hardening before launch. Rate limits do not yet
cover IPv6 aggregation or global attack traffic; configure edge rate limiting.
Do not log raw URLs, cookies, provider payloads, codes, or document contents.

## Integration contract with ordered envelopes

This draft snapshots the current single `transmissions.source_key` under an
independently generated delivery ID; it does not change any envelope or bundle
IDs. The parallel ordered-document work must supply an immutable, ordered
snapshot adapter of opaque document IDs and server-owned object keys before
integration. Encrypt each document against its delivery and opaque document ID;
never accept an object key from recipient input. Decide owner-facing delivery
status, transaction/cleanup semantics, revocation and multi-document UI jointly.
Migration `0040_email_portal.sql` is intentionally independent; coordinate its
number if the parallel branch uses it.

## Configuration, after review only

Apply the migration through the normal reviewed deployment process, provision
path bypasses as above, verify the `PORTAL_EMAIL` Workers email binding, provision the
onboarded `PORTAL_SENDER`, set exact HTTPS `PORTAL_ORIGIN`, and keep a dedicated
random 32-byte base64url `PORTAL_KEY` secret backed up and retained for the
lifetime of all copies. Configure `TELNYX_VERIFY_PROFILE_ID` and the existing
`TELNYX_API_TOKEN` only if PIN is used. No feature flag is required. This branch makes no live configuration changes.

Email attempts are durably claimed once per transmission before provider submission.
Configuration failures are retained in Records. A crash or timeout at the
provider boundary remains unknown; do not retry without checking. Scheduled
cleanup removes expired sessions, old rate buckets, and up to 50 expired or
revoked encrypted copies per run while retaining delivery and consent metadata.
A failure before the email attempt row is created, or between encrypted R2 write
and database insertion, still needs reconciliation; R2 lifecycle policies should
be considered for orphan cleanup. Existing delivery rows from the earlier draft
are not backfilled into email_attempts.
