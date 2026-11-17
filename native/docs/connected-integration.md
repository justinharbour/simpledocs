# Connected-instance integration foundation

Status: **foundation only.** `native/Packages/SimpleDocsConnected` is pure Swift logic with tests. It makes no network request, reads no Keychain, stores no token and is not linked into any app target. Native sign-in for self-deployed instances is **not verified**, so every credential decision in this package is a denial. Nothing here shows that an instance exists, that an address belongs to a trusted identity provider, or that any capability is available.

It follows the proposed architecture and integration contracts in PR #2 (`docs/architecture.md`, "Native capability boundary" and "Independently operated instances"; `docs/contracts.md`, "Instance onboarding and provisioning"). Those files are not on `develop` yet, so they are not linked. Both are proposals; this package implements only the client-side rules that do not depend on undecided items.

## What the package provides

| Type | Purpose |
| --- | --- |
| `InstanceOrigin` | Strict parser for a user-entered address. Accepts only `https://<dns-name>[:port]`, lowercased, with default port 443 normalised away. |
| `ConfirmedOrigin` | Can only be built when the acknowledged text equals the canonical origin, modelling "the person was shown this origin and accepted it". |
| `InstanceLinkID`, `SessionScope` | A device-local link identity and the names derived from it: Keychain account, cache directory components, idempotency namespace. Names only; no storage. |
| `OriginBinding` | `permits(url, for: origin)` for requests and redirects; `apiURL(segments:)` builds `/api/v1/...` URLs from validated segments. |
| `InstanceRegistry` | In-memory linked instances, explicit selection, an epoch that changes on every switch, and unlink receipts. |
| `ContextBinding` | Pins a pending action to the link and epoch it started under. |
| `CredentialPolicy`, `NativeAuthStatus` | Gate for attaching a credential to a request. Fails closed. |
| `APIVersion` | Picks a supported major version or refuses. |

## Address parsing

The parser does not rely on `URL` or `URLComponents` leniency. It rejects:

- non-HTTPS schemes, missing scheme, scheme-relative addresses
- user info, including `host@evil` confusions and backslashes
- any path other than a single `/`, any query or fragment
- non-ASCII or control characters (people must use the punycode form; punycode hosts are flagged by `hasPunycodeLabel` so the UI can display them prominently)
- IP literals in any form (dotted, decimal, hex, bracketed IPv6), single-label hosts, and `localhost`, `.local`, `.internal`, `.lan` and similar suffixes
- empty, over-long, hyphen-edged or non-LDH labels, trailing dots, percent escapes
- ports that are empty, zero-padded, signed, zero or above 65535

Rejecting IPs and local names is a deliberate product choice for an App Store client that talks to a Cloudflare-hosted instance. A person developing an instance locally cannot link it. A separate, explicit developer path would need its own review.

Format validity is **not** instance validity. No code path may describe a parsed origin as verified, discovered or trusted.

## Instance-bound session isolation

- A link has a random local `InstanceLinkID`. Re-linking the same origin after unlinking creates a new ID, so old state cannot be mistaken for the new link.
- `SessionScope` derives Keychain account, cache path and idempotency namespace from the SHA-256 of the canonical origin (port included) plus the link ID. The raw host is not used in names.
- Selection is explicit. Linking never selects. Every change of selection, and unlinking the selected instance, advances the epoch. A `ContextBinding` taken before a switch stays stale even if the person switches back, so a draft or submit cannot silently retarget another instance or revive after a round trip.
- Unlinking returns a receipt listing what the caller must purge (session material, cached records, idempotency keys, pending actions) and records `serverRevocation: .notAttempted`. Local removal is not evidence that the server ended the session.
- Idempotency keys, cached records and sessions are never shared across links.

## Credential policy (fail closed)

`NativeAuthStatus` has `unknown` and `unsupported` only; there is deliberately no `verified` case. Adding one is a reviewed change that must come with the verified flow. `CredentialPolicy.evaluate` returns a `CredentialDenial` and has no allow result today. The order is: no selection, stale context, origin mismatch, then authentication not verified. Redirects are checked on both the source and the destination and never get an exemption. Callers must not attach a bearer token, cookie or Access token on any denial, and must not fall back to an embedded service token or provider key.

## Not integrated or not verified

- **Not wired into the app.** No app target, `project.yml` entry, shared `SimpleDocsKit` source, or CI job references this package. CI runs only `SimpleDocsKit`, so these tests do not run in CI until a workflow step is added (`swift test` in `native/Packages/SimpleDocsConnected`, with full Xcode for the Swift Testing macros).
- **No sign-in.** The Access/OAuth flow, issuer and audience binding, renewal and revocation are undecided (see PR #2 architecture). The package cannot authenticate anyone.
- **No discovery.** The discovery route, schema and its authenticity binding are undecided. `APIVersion.negotiate` only handles a list the caller supplies, and that list must be treated as untrusted. `InstanceTrust` has a single `userEnteredUnverified` state.
- **No networking.** No `URLSession`, TLS or certificate policy, redirect delegate, timeout, response-size limit, or error-envelope decoding. `OriginBinding` and `CredentialPolicy` are the checks a future transport must call; the transport itself is unwritten and unreviewed.
- **No persistence.** The registry is in memory. Keychain storage, cache purge, relaunch behaviour and account-switch UI do not exist. `SessionScope` only produces names.
- **IDN.** Non-ASCII hosts are rejected rather than converted. Whether to convert and how to warn about homograph look-alikes is unresolved; the punycode flag is a display aid only.
- **Same-origin only.** Cross-origin identity providers are expected for real sign-in. Allowing one requires an explicit, per-instance trusted-issuer design that does not exist, and this package would deny it today.
- **Duplicate detection** is by canonical origin only; two instances behind one host with different identity configuration are not modelled.
- **No cancellation of in-flight requests** on switch or unlink; the epoch lets a caller detect staleness but nothing enforces it.
- **Tests** ran with `swift test` on macOS under Xcode 27.2. The library compiled for generic iOS with `xcodebuild`, but iOS tests were not run, and the package was not compiled inside the Xcode app project.
- **API contract is a proposal.** `/api/v1` and the version list are not a deployed API.

## Test

```sh
cd native/Packages/SimpleDocsConnected
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # if xcode-select points at Command Line Tools
swift test
```
