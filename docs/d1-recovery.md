# Production D1 recovery

Database: `simpledocs-d1-prod` (`b31882a3-2a9e-45de-bfe2-3021785420db`).
On 2026-11-17 Cloudflare's database API reported `version: production`; its
Time Travel bookmark API returned
`00000001-00000000-00005126-9855d43e24cdbcd7ddb24cd9ecdac815`.
This bookmark is a point-in-time reference, not a permanent backup: it expires
with the applicable history window. The initialized schema was verified in
GitHub Actions run 44039347148.

Cloudflare documents automatic Time Travel for the production backend, with
7 days of history on Workers Free and 30 days on Workers Paid. The applicable
plan and required retention for this installation have not been confirmed. No
independent long-term backup or restore test has been verified. An owner must
decide whether the applicable window is sufficient before production binding.
Longer retention requires a separately secured export and retention procedure.
See [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Incident procedure

1. Stop application writers, including fax submission and deployments, and
   identify the affected database, incident time and desired recovery point.
   Preserve incident evidence without exposing document contents or credentials.
2. With authorized Cloudflare credentials, use the reviewed Wrangler configuration
   to obtain the current bookmark: `wrangler d1 time-travel info simpledocs-d1-prod`.
   Record it and resolve the desired timestamp using the same command with
   `--timestamp=<ISO-8601 timestamp>`. Confirm the point is within the account's
   actual retention window. Retain any available independent backup securely.
3. Obtain explicit owner approval before restoring. Time Travel restore overwrites
   the database in place and cancels in-flight queries; it is not a harmless test.
   Use `wrangler d1 time-travel restore simpledocs-d1-prod --bookmark=<approved-bookmark>`
   only after checking the target account and database. Record the previous
   bookmark returned by the restore so that an undo can be considered.
4. Verify migration history, schema and relevant records without logging sensitive
   data. Reconcile fax intents with Telnyx before resuming writes: rolling back
   an intent cannot undo an already submitted fax, and an uncertain fax must not
   be automatically resent. Resume service only after the owner approves.

No restore has been executed as part of this procedure.
