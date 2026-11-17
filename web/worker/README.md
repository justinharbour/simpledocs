# Owner Worker draft

Build the deployable files with `pnpm install --frozen-lockfile`, `pnpm build`,
and `pnpm build:worker` from `web/`. The resulting static directory is `dist/`
and the single Worker module is `build/worker/index.js`. These outputs are not
an authorization to deploy; record and verify their digests against the reviewed
source and keep them unchanged between infrastructure plan and apply.

This is a protected static preview, not a functional application. It does not
implement D1, R2, provider actions, webhooks, or persistence. The deployment is
not ready for production until Access configuration and infrastructure ownership
are reviewed and verified. Every request runs through the Worker; missing or
invalid Access assertions fail closed. Configure `ACCESS_TEAM_DOMAIN` as the
exact HTTPS Cloudflare Access team origin and `ACCESS_AUDIENCE` as the Access
application audience. The infrastructure must attach the approved Access
policy and independently protect the hostname. Do not enable workers.dev or
preview URLs without testing the same authentication boundary.

The owner has deferred the PostGrid provider-preview requirement for the rough
draft. No mail sending is implemented or enabled by this change; eventual live
sends require a clear user confirmation and safe handling of uncertain outcomes.
