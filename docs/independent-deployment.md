# Independent Cloudflare deployment

Simpledocs is independent of Lake Ave. The manual GitHub Actions workflow deploys
only the reviewed `main` branch, using repository variable `CLOUDFLARE_ACCOUNT_ID`
and repository secret `CLOUDFLARE_API_TOKEN`. Scope the token to the intended account and required
Worker permissions. Never put token values in the repository or in chat.

This initial workflow deploys **no public route**. `workers_dev` and preview
URLs are disabled, and the Worker rejects requests without a verified Access
assertion. It does not create an Access application, hostname, D1, R2, or queues.
Before connecting the hostname, independently configure and verify Access, set
the team origin and application audience in the Worker, verify there is no
hostname collision, and review the routing change. Before binding D1, create the
database, apply and verify the reviewed migrations, and establish recovery and
backup procedures. No provider sending is enabled.

## Provisioning sequence (not yet executed)

### Owner hostname review (2026-11-17)

Read-only account inventory found the active `justinharbour.dev` zone in the
target account and no exact DNS record for `simpledocs.justinharbour.dev`.
The account-level Access application listing had no application containing that
hostname. Recheck zone-level applications, wildcard DNS and routes, custom
domains, and overlapping Access rules immediately before making changes; this
inventory alone does not establish exclusive hostname ownership.

The intended reusable policy is `36ee1f67-a91a-494c-b503-94bf48820ffa`
(`Allow Entra Authenticated Users Only`). It allows the Azure AD login method
`bc4cede3-4ee0-4bd6-9393-34c10ca6a6d8`, configured with directory ID
`b345fb42-c8c3-4e04-93a5-974f7e5eb2ad`. This verifies the configured login
method and directory, not the Entra tenant's own membership or authorization
settings. Do not modify the shared policy or identity provider. The Access team
origin is `https://justinharbour.cloudflareaccess.com`; the new application's
audience must be obtained after creation and checked before deployment.

Provision the self-hosted application through a separately reviewed Wrangler/
GitHub Actions path, attaching the existing reusable policy and no bypass or
additional allow policies. Verify the application and policy association by
read-back before enabling the hostname. Add the exact team origin and application
audience as Worker variables in a reviewed change and deploy them while the
Worker remains unrouted. Only then review a separate route/custom-domain change.
Test an unauthenticated request, a non-tenant identity, the owner's allowed
login, and static assets; if access controls fail, disable the route immediately.
An Access app alone does not prove enforcement until requests traverse the
hostname, and a verified JWT alone does not replace the Access policy check.
These owner-specific settings must not become requirements for other installs.

1. Inventory `simpledocs-wkr-prod`, `simpledocs-d1-prod`, the hostname and any
   Access applications in the target account. Stop on an ownership collision;
   do not adopt or overwrite an existing resource without reviewing its owner.
2. Create a self-hosted Access application for `simpledocs.justinharbour.dev`
   with the owner's existing tenant-restricted policy. Record its audience and
   the Access team origin. The application and route must be in place and tested
   together; never publish an unprotected hostname. The Worker independently
   validates Access assertions against that issuer and audience. Set both as
   Worker variables in reviewed Wrangler configuration before enabling a route.
3. Create `simpledocs-d1-prod` with Wrangler only if the inventory confirms it
   is absent. Record its database ID. Copy `web/wrangler.migrations.example.jsonc`
   to an untracked migration-only config, replacing the placeholder ID with the
   newly verified ID. Do not add a DB binding to the deployment config yet.
4. Review and apply the numbered migrations in order using `wrangler d1
   migrations list DB --remote` and `wrangler d1 migrations apply DB --remote`
   with that migration-only config. Verify migration history and the expected
   schema using read-only queries. In CI, Wrangler skips the confirmation prompt;
   therefore migrations must be separately reviewed before execution, not run
   automatically as a side effect of deploying the Worker.
5. Verify D1's production storage version and record a Time Travel bookmark and
   recovery procedure before changes to a populated database. Time Travel restore
   overwrites the database and cancels in-flight queries; never run it as a test.
   Confirm the retention period for the account's plan and arrange longer-term
   backups if needed.
6. Only after schema verification, add the verified database ID as the Worker
   `DB` binding in a reviewed deployment change. Test Access denial, owner login,
   saved drafts and conflict handling on the real hostname without sending mail.

References: [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
and [Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/).

## Mail foundation upgrade plan (not authorized or executed)

The production Worker already has a D1 binding in `web/wrangler.jsonc`; the
initialization script is not an upgrade tool and must not be run against it.
Before any separate deployment, independently verify the account, database ID,
ownership, existing migration history and schema, active writers, backup and
recovery procedures, and a current Time Travel bookmark and retention. Review
`0004_mail_intents.sql`, `0005_mail_unresolved_actor.sql`, `0008_mail_acknowledgement.sql` and the complete pending migration list; do not assume
earlier migrations were applied. Arrange a safe write window and apply only the
reviewed pending migrations through the separately authorized Wrangler migration
path, then read back history and schema without querying private content. Do not
run migrations automatically as part of the deploy workflow. Time Travel restore
overwrites data; it is an explicitly authorized recovery operation, not a test.
The partial unique index in 0005 fails if any actor already has multiple
unresolved claims; stop and reconcile through a separately reviewed process,
never discard or reset rows to force the migration. Deploying the mail sender
without this index would not enforce the actor-wide gate, so verify it exists
before deploying the new Worker. Migration 0008 also intentionally fails if
existing unacknowledged accepted and unresolved rows conflict for an actor;
do not discard rows. Verify the expanded unique index and acknowledgement
column before enabling the new code. Numbers 0006 and 0007 are used on other
active feature branches; recheck the actual pending migration list and merge
coordination before release rather than assuming those branches have landed.

Deploy the reviewed Worker only after schema verification. Keep `MAIL_ENABLED`
unset and do not configure a PostGrid key during this upgrade. The mail routes
require the same verified Access assertion as all other routes; test denial and
owner-only access on the actual hostname without submitting an order. Existing
Worker deployment can happen only through the independent repository's reviewed
main-branch GitHub Actions workflow, not this PR. Verify rollback compatibility
and do not drop the intent table or erase claims during rollback.

Enabling mail is a separate reviewed owner decision. Only then provision
`POSTGRID_API_KEY` as an encrypted Worker secret for the intended account and
environment through the approved Wrangler/GitHub Actions secret-handling path;
never put its value in source, vars, build artifacts, logs, shell arguments or
chat. Verify secret presence and correct Worker binding without printing its
value, and set `MAIL_ENABLED=true` only in the separately reviewed activation.
Check whether the deployment command preserves existing secrets and variables
before executing; the current workflow explicitly sets only Access variables
and does not provision the PostGrid secret or enable mail. Define rotation and
revocation before activation. No production, sandbox or paid provider action is
authorized by this plan.

Mail drafts and frozen request bodies contain sensitive personal information in
D1. Restrict database access and retention, review Cloudflare request/logging and
exception telemetry settings, and prohibit request/response body capture and
provider key logging before activation. The mail code contains no explicit
content or credential logging, but that does not establish the configuration of
platform or external logging. Review the operator reconciliation procedure in
`web/worker/README.md` before enabling sending.
