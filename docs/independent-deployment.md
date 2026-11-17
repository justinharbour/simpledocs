# Independent Cloudflare deployment

Simpledocs is independent of Lake Ave. The manual GitHub Actions workflow deploys
only the reviewed `main` branch, using repository secrets `CLOUDFLARE_ACCOUNT_ID`
and `CLOUDFLARE_API_TOKEN`. Scope the token to the intended account and required
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
