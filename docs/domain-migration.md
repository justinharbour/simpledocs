# Simpledocs hostname migration: review and promotion plan

This is a **plan, not an authorization to deploy**. The target is
`https://simpledocs.justinharbour.com` as canonical production;
`https://simpledocs.justinharbour.dev` is ultimately reserved for an isolated
preview. Initially keep `.dev` working as a **temporary production compatibility
route**, not a preview. Do not attach the new route before its Access protection
is in place. Simpledocs remains
an independent project: deploy through this repository's reviewed GitHub Actions
and Wrangler workflow, not Lake Ave infrastructure.

## Inventory (read-only, 2026-11-17)

- Both parent zones are active in the accessible Cloudflare account. The `.dev`
  hostname has a proxied DNS record and is a custom domain of
  `simpledocs-wkr-prod`. No matching `.com` record or Worker route/domain was
  found in the inspected inventory. Recheck DNS, wildcard routes, certificates,
  and ownership immediately before promotion.
- The existing self-hosted Access application covers only the `.dev` hostname;
  it uses one allow policy, managed OAuth, and the native redirect URI
  `dev.justinharbour.simpledocs:/oauth/callback`. Three more-specific Access
  applications bypass Access for the signed fax, voice, and messaging webhook
  paths. Their `.dev` equivalents must not be removed.
- The Worker checks one `ACCESS_AUDIENCE`. A separate `.com` Access app would
  normally have a different audience; it is not sufficient simply to add a
  custom domain. Investigate and test extending the existing application with a
  second public destination while preserving its audience, policy, identity
  provider, OAuth configuration, and existing destination. Verify actual token
  behavior and app discovery for both hostnames before rollout. Do not broaden
  the allow policy or bypass the entire hostname.
- Telnyx's `simpledocs-fax-prod` and `simpledocs-voice-prod` applications point
  to `.dev` at `/webhooks/telnyx/fax` and `/api/webhooks/telnyx/voice`;
  neither has a configured failover URL. The configured SMS number's messaging
  settings returned an empty messaging profile ID. The listed messaging profile
  has no webhook URL. This does not establish actual SMS delivery; the owner must
  trace the number's effective inbound configuration before changing it.
- The native default and remembered instance are `.dev`. The callback URI above
  is an app URL scheme, not the web hostname. Existing installations remember
  their chosen instance and store sessions per instance; changing a default does
  not migrate those settings or sessions. Confirm sign-in and explicit re-linking
  on each supported platform before changing the default.

## Owner prerequisites

1. Confirm authority over both zones and that the GitHub Actions Cloudflare
   token can manage the destination zone, Worker custom domains, and Access app
   and policies. Check for competing DNS/route ownership and confirm certificate
   provisioning. Do not print credentials.
2. Confirm tested D1 and R2 backups and recovery, and capture the current Worker
   version, both routes, Access application configuration/policy and provider
   callback configuration in a secure operational record. No database migration
   or new data store is needed solely for a hostname change.
3. Confirm native OAuth discovery and registered redirect behavior for both
   destinations, including the existing custom scheme, active sessions, token
   audience and a clean sign-in. Confirm whether external identity providers
   have additional callback/allowed-origin restrictions.
4. Inventory effective Telnyx SMS routing and any external callbacks, API
   clients, bookmarks, generated email/portal links and outstanding links. Keep
   existing URLs and explicitly decide how to handle those still in use before
   the `.dev` preview cutover. The fax alert sender
   address is an email address, not a web route; do not change it as part of this
   migration without separately verifying mail-domain ownership and delivery.
5. Agree on an observation period, controlled test recipients and rollback
   authority. Live fax, voice, SMS and email tests can send communications or
   incur charges and require separate owner authorization.

## Proposed reviewed rollout

1. Implement and test a fail-closed deployment change that extends the existing
   Access app to both exact hostnames without changing its audience or OAuth
   settings. Provision and verify narrowly scoped `.com` webhook bypasses for
   the same three paths, checking existing policies rather than silently adopting
   or overwriting conflicting apps. Confirm each endpoint still enforces Telnyx
   signature validation; all other paths must remain protected. Add automated
   mocked API and failure-path tests. Review Access destination matching and
   precedence against current Cloudflare behavior.
2. Only after Access configuration succeeds and is verified, add the `.com`
   custom domain to `web/wrangler.jsonc` **alongside** `.dev`, and deploy the
   reviewed default branch via the manual production workflow. Make sure the
   Access provisioning step completes before Wrangler attaches the hostname;
   fail closed on any conflict or verification error. Do not redirect the old
   hostname: POST webhooks, OAuth flows, and historical links may depend on it.
3. Verify HTTPS, unauthorized denial, authorized browser and native sign-in,
   JWT audience verification, and both domains' normal application behavior.
   Validate webhook signature rejection and successful delivery with explicitly
   authorized controlled tests. Check DNS and Access independently, not just a
   successful deploy. Monitor provider failures and application health.
4. In a subsequent reviewed change, switch newly generated links and native
   defaults where appropriate. Preserve remembered `.dev` settings and provide
   an explicit user-driven switch and reauthentication; do not silently move
   origin-bound sessions. Review any provider and identity allowlists.
5. Only after `.com` is proven and the owner confirms effective routing, update
   Telnyx fax, voice and SMS callbacks through their established ownership path,
   one at a time, with delivery verification and monitoring. Preserve `.dev`
   throughout the observation period. Update known clients and old links; do
   not switch `.dev` to preview while production callbacks, installed clients,
   provider retries, or important links still rely on it.

## Eventual preview cutover (separate scope and approval)

The same hostname cannot simultaneously be the production compatibility route
and an isolated preview. An optional temporary redirect to `.com` is not a
substitute for migrating webhook POSTs, OAuth clients and old links: redirects
can change request semantics or fail at providers and Access. Any redirect must
be separately designed, tested and time-limited. Do not treat preview as ready
until production dependencies on `.dev` have been removed or explicitly
accepted by the owner.

With separate explicit approval, design a distinct preview Worker and deployment
workflow with its own D1 database, R2 buckets, queues, secrets, provider/test
configuration and Access application/policy. Preview must not bind, read, write
or otherwise mutate production data or send live communications. Disable live
provider integrations by default and test isolation and denied cross-environment
access. Review safe test data, resource ownership, cost, retention and rollback.
Only after those resources are independently provisioned and verified should a
reviewed change move `.dev` from the production Worker to the preview Worker.
Do not create or deploy preview infrastructure under this plan alone.

## Rollback

During the production transition keep `.dev` route, Access applications, OAuth
registration and callbacks intact.
If `.com` validation fails, stop promotion and continue using `.dev`; revert any
provider callbacks individually to the recorded `.dev` URLs, and verify delivery.
Revert application defaults through the reviewed deployment/release process;
do not remove Access protection while a `.com` route remains reachable. Restore
the recorded Worker version through the normal reviewed workflow if necessary,
without reverting D1/R2 data or deleting either route. Before the later preview
cutover, prepare a separate rollback that restores `.dev` routing only after
checking isolation, Access, DNS and in-flight requests; do not connect preview
resources to production data as a rollback shortcut. Investigate any queued
or uncertain provider events before retrying to avoid duplicate communications.
