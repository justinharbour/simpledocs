# Telnyx fax infrastructure: review only

This optional, disabled outbound voice profile is a building block, not an
operational fax deployment. The default configuration creates nothing. It does
not change telephone numbers, existing profiles, or existing applications.
No plan, apply, import, provider call, routing change, or paid send is
authorized by the presence of this file. The provider is a third-party alpha
provider whose author says it is not recommended for production. Review its
binary, credentials, lifecycle and state behavior before any production use.

`petsinc/telnyx` 2.4.0 supports `telnyx_outbound_voice_profile`; this profile is
created **disabled**, with a required explicit spend limit, concurrency limit,
country allowlist and billing group when opted in. Turning it on requires a
subsequent reviewed code change, after confirming the provider and Telnyx
actually enforce each field. `prevent_destroy` is a guard, not protection
against deleting the resource block or manually changing state. Never import a
shared existing profile. A separate account-scoped API credential must be
supplied through the operator's secure environment, not committed or logged.
The provider reads `TELNYX_API_KEY`, even when no profile is enabled. Its
[v2.4.0 client](https://github.com/petsinc/terraform-provider-telnyx/blob/v2.4.0/telnyx-rest-client/pkg/telnyx/client.go)
unconditionally prints request and response bodies via
[utils.go](https://github.com/petsinc/terraform-provider-telnyx/blob/v2.4.0/telnyx-rest-client/pkg/telnyx/utils.go),
independent of log level. **Do not run this provider with production credentials**
until that disclosure risk is fixed or independently accepted with appropriately
restricted logs; do not use it for credential-bearing resources. The provider
also retries 429 responses. Verify least-privilege permissions and retry behavior.

The provider's [2.4.0 resource inventory](https://github.com/petsinc/terraform-provider-telnyx/tree/v2.4.0/docs/resources)
does **not** provide a Programmable Fax Application resource or an existing
phone-number assignment resource. `number_order` purchases numbers and must
not be used to adopt or move an existing number. Telnyx's
[fax quickstart](https://developers.telnyx.com/docs/programmable-fax/quickstart)
requires a fax application, webhook, number assignment and outbound profile.
Implement and review a declarative provider extension or another single-owner,
auditable management path for those missing objects before cutover. Do not use
an untracked `local-exec` or a dashboard change as a substitute.

The owner has designated one fax number and one voice number; only those two
may move. Numbers and existing connection identifiers belong in an operator's
private cutover record, not this public repository. Capture and verify both
current connections, owners, settings, dependent services and rollback steps
immediately before any independently authorized cutover. Never change shared
Commcenter applications or profiles. Verify capability, pricing and consent.

Inbound fax remains disabled pending the deployment checks in
`web/worker/INBOUND-FAX.md`. The dedicated webhook path verifies signatures,
persists an inbox row and stores received PDF media privately before returning
success. It is deliberately not bound or enabled in production configuration;
alerting and refresh/recovery remain unimplemented. Authenticated media access
requires an explicit shared-inbox subject allowlist.

Before any later plan/apply: confirm independent Simpledocs state ownership,
encrypted state and backups, provider checksums, scoped permissions, spending
and destination limits, review the exact plan, and obtain deployment and
routing approval. Approval of paid faxes is not a destination or document;
never send without both supplied and an explicit per-send confirmation.
