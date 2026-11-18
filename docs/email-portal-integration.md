# Recipient email portal

Send emails a seven-day invitation to download the exact ordered, optionally
numbered PDF from the envelope. Email acceptance is not delivery confirmation.
Records shows submission status and allows revoking a link; revocation cannot
recall copies already downloaded. Fax and mail retain their existing transports.
Email requests use `emailDocuments` or `numberedEmailDocuments` multipart fields
so older Workers reject the whole request instead of silently dropping email.

## Production rollout

1. Preserve both protected owner hosts. The owner UI can send and revoke on
   `simpledocs.justinharbour.com` and `simpledocs.justinharbour.dev`, but invite
   links and recipient cookies use only `https://simpledocs.justinharbour.com`.
2. Create six separate self-hosted Cloudflare Access applications with a single
   `.com` destination each: `/portal`, `/portal/exchange`, `/portal/status`,
   `/portal/pin/start`, `/portal/pin/check`, and `/portal/document`. Each uses one
   Bypass/Everyone policy. Never add a wildcard or bypass an owner `/api` path.
   Verify edge behavior on both hosts without sending anything: the recipient
   landing page is public on `.com`; an unauthenticated document or status
   request is denied; `.dev`, the owner app, owner APIs, and adjacent/normalized
   paths remain protected. The Worker independently verifies Access JWTs on
   owner routes and accepts only the exact public route set. The deploy workflow
   validates policy metadata and does not create recipient exceptions.
3. Store a backed-up dedicated 32-byte random base64url `PORTAL_KEY` in the
   repository's Actions secrets. Keep the key for the life of its copies and
   protected backups. To rotate, set the outgoing key as `PORTAL_PREVIOUS_KEY`
   before replacing the active key in Actions; deploy both in one release. Keep
   it until those copies expire and verify backup recovery before discarding it.
   Removing the Actions secret does not remove an existing Worker secret; retire
   it separately after confirming it is no longer needed. Rotate at most once
   within the lifetime of an active copy. The independent Simpledocs Wrangler
   workflow binds `PORTAL_EMAIL` and uses the verified `mail.justinharbour.com`
   sender domain.
4. Set Actions variable `TELNYX_VERIFY_PROFILE_ID` to a dedicated Simpledocs
   profile accessible by the actual production `TELNYX_API_TOKEN`, with a daily
   spend cap and no external webhook. Do not reuse CommCenter profiles. Review
   recipient consent wording and the allowed destination region. Verify metadata
   with a read-only profile GET; do not initiate a verification as a smoke test.
5. Promote through `develop` and `main`. The production workflow performs
   read-only provider and Access preflight before migration or deploy. Verify
   migration history, Worker binding metadata, and the non-sending checks above.
   End-to-end delivery testing requires separate permission for each real send.

## Security and failure behavior

- The 256-bit token is in the URL fragment. A separate random access code in
  the email body must be manually entered; a scanner that merely follows the
  link or clicks Continue cannot redeem it. A service that reads and submits
  both values still has the same authority as the recipient's mailbox. This
  is not multi-factor authentication; select phone verification when needed.
- Redemption atomically consumes the invite and opens one 30-minute session.
  A same-page retry can recover a lost response using its in-memory random
  verifier without extending the server expiry. After browser/session loss,
  contact the sender; no automatic resend or new session is created from a used
  link. The cookie is `__Host-`, Secure, HttpOnly, and SameSite=Strict.
  Mutations require exact same origin. No keys, codes, or raw links are logged.
- R2 stores an AES-256-GCM encrypted snapshot, bound to its delivery and document
  by authenticated data. The Worker has the key; this is not end-to-end
  encryption. The original PDF retains its existing access and storage policy.
- Verify is optional per invitation. The recipient must enter the full number
  provided by the sender, attest to controlling it, and explicitly consent
  before one automated request. An accepted code must match that verification
  ID. PIN attempts, client and destination rates, total traffic, and provider
  spend are bounded. Rate counters are keyed; verify the edge's client-IP
  behavior and configure edge abuse protection before making the portal public.
- Missing bindings or credentials return errors; there is no feature flag.
  Once provider submission starts, failures can have an unknown outcome. No
  provider call is retried automatically. A durable email attempt prevents a
  duplicate invitation for the same envelope.
- The cron removes expired sessions and encrypted copies after expiry or
  revocation. It also retries orphan deletes after ambiguous R2 writes. Keep
  the existing R2 protections, monitor cleanup, and set a policy for owner
  records and consent metadata before production use.
