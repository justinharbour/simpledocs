# Owner Worker draft

Build the deployable files with `pnpm install --frozen-lockfile`, `pnpm build`,
and `pnpm build:worker` from `web/`. The resulting static directory is `dist/`
and the single Worker module is `build/worker/index.js`. These outputs are not
an authorization to deploy; record and verify their digests against the reviewed
source and keep them unchanged between infrastructure plan and apply.

This is a protected draft, not a functional application. It does not provision
D1 or implement R2, provider actions, or webhooks. The deployment is
not ready for production until Access configuration and infrastructure ownership
are reviewed and verified. Every request runs through the Worker; missing or
invalid Access assertions fail closed. Configure `ACCESS_TEAM_DOMAIN` as the
exact HTTPS Cloudflare Access team origin and `ACCESS_AUDIENCE` as the Access
application audience. The infrastructure must attach the approved Access
policy and independently protect the hostname. Do not enable workers.dev or
preview URLs without testing the same authentication boundary.

The mail-draft API uses the verified Access subject and a `DB` D1 binding. It
returns 503 without that binding; the infrastructure does not yet provision it
or apply the migrations, and the UI is not connected. SQLite-backed tests are
not a substitute for D1 integration or live security testing. Writes require a
same-origin JSON request, bounded body, and a current revision.

The owner has deferred the PostGrid provider-preview requirement for the rough
draft. No mail sending is implemented or enabled by this change; eventual live
sends require a clear user confirmation and safe handling of uncertain outcomes.
