# Native releases

This workflow depends on the unified native project in draft #68, including its
two share extensions, version build settings and `com.justinharbour.simpledocs`
identifiers. Merge and reconcile that project before enabling releases. It does
not release the older separate Direct application. No tvOS target exists; add
one and its real signing configuration when it does, rather than claiming a
tvOS release today.

## GitHub setup and flow

The `develop` push workflow runs release-please with the explicit manifest and
configuration for the `native` component only. Web/backend-only commits do not
independently trigger a native version bump. Native release tags use
`native-vMAJOR.MINOR.PATCH`. It
opens a conventional-title release PR to `develop`; merge it through the normal
review and CI process. The subsequent `develop` push creates a GitHub release
and tag. Promote `develop` to `main` through the normal reviewed promotion PR.
Once Apple setup is complete, dispatch the TestFlight workflow **on main** with
the published tag. It verifies the tagged commit is an ancestor of main, checks
its version, and builds that exact commit. A GitHub release means the tag was created, **not**
that Apple accepted, processed, reviewed, or distributed a build. Check both
matrix jobs and App Store Connect. Upload does not submit for App Review or
automatically add external testers. Follow the repository's branch protection
and promotion process; do not bypass checks.

Create repository secret `RELEASE_PLEASE_TOKEN`: a fine-grained PAT belonging to
a dedicated release identity, scoped to this repository with Contents and Pull
requests read/write and Issues read/write (for release-please labels). Grant
the identity appropriate branch protection access without bypassing review.
Unlike `GITHUB_TOKEN`, this identity causes release PRs to trigger ordinary PR
CI. If organizational policy requires it, allow Actions to create pull requests.
Rotate and restrict this credential. The token is used only in the release job;
Apple secrets are used only by the explicitly dispatched main-branch jobs, never PR jobs.

The GitHub API reported no classic branch protection or repository rulesets on
`main` or `develop` during review. This is a release security risk: configure
effective branch/ruleset protection requiring reviewed PRs and `pr-gate`,
restrict pushes and workflow modification, and prohibit bypasses before storing
these credentials or promoting releases. The workflow's branch/ref and ancestry
checks cannot replace protected branches. Verify any inherited policy separately.

The unified app defaults to `https://simpledocs.justinharbour.com` and its Access
team to `https://justinharbour.cloudflareaccess.com`. The compatible protected
Worker and its migrations, notably `0030_push_devices.sql` and
`0044_push_device_bundle.sql`, must already be deployed before distributing
this app. Push requires separately configured Worker secrets `APNS_KEY_P8`,
`APNS_KEY_ID`, and `APNS_TEAM_ID`; they are not the App Store Connect API key.
The release build registers the production APNs environment and
`com.justinharbour.simpledocs`, which the compatible Worker accepts for both
platforms. No live hostname, backend deployment, APNs configuration, or push
delivery is verified by this repository check. See `push.md` for older topics.
The prepared-fax contract depends on PR #72's compatible backend; #68 has adopted
that contract, but #72 was not merged into this branch. Coordinate and verify
the deployed backend contract before distributing a build; otherwise fax review
cannot be assumed functional.

`native/version.txt` and `.release-please-manifest.json` start at 0.0.0, not a claim
that a version was shipped. Confirm existing GitHub tags and App Store Connect
versions before first release; bootstrap or update the manifest/version to the
actual last release if necessary. Conventional commits control release-please's
SemVer. The release version supplies CFBundleShortVersionString; this workflow's
monotonic GitHub `run_number` supplies CFBundleVersion for both platforms and
extensions. Before enabling, ensure it exceeds existing Apple build numbers for
the relevant version. Run numbers reset if the workflow is recreated; never
reset it without choosing a higher numbering strategy. Re-running an already
uploaded release uses the same build number and Apple may reject it as a
duplicate. For a failed upload, inspect Apple first; do not blindly retry a
successful platform. A new release is the safe normal recovery; a deliberate
recovery workflow would need a separately allocated higher build number.

`xcode-27`/Xcode 27.2 must be an available **ephemeral, trusted** GitHub runner
with no untrusted jobs sharing its user account. The script temporarily changes
the user keychain search list and installs profiles, then restores/removes them;
abrupt runner termination can prevent cleanup. Do not use a persistent shared
self-hosted machine for signing. The GitHub release is created before the
matrix; a signing failure does not roll it back. This path has not been tested
against an Apple account or an actual runner.

## Apple prerequisites

Confirm ownership of the identifiers and team before creating anything. In
Certificates, Identifiers & Profiles register the actual app and extension App
IDs on each platform, enable the exact entitlements requested by their source
files, and associate the App Group `group.com.justinharbour.simpledocs` with
each. Enable Push Notifications for the apps, with production APNs configured
in the service. Generate **App Store distribution** profiles for each app and
each extension, using the same team and appropriate distribution certificate.
Xcode uses the production APNs entitlement for distribution. Verify the Apple
portal's platform-specific App ID/capability support and the final signed
entitlements, including App Group and sandbox, rather than assuming they match.
Create the App Store Connect app record and platform entries for the shared
bundle identifier; complete agreements, tax/banking as applicable, metadata,
and TestFlight compliance/tester requirements. App icons, privacy declarations,
and other Apple validations may still block processing. Apple Developer Program
membership is required.

Create an Apple Distribution signing identity with its private key, and an
appropriate Mac App Store installer distribution identity with its private key
for the exported signed `.pkg`; export both in a password-protected PKCS#12
bundle. Match certificates to profiles. In App Store Connect create a **team**
API key with the least role that can upload builds (Developer or App Manager,
depending on account permissions), and retain its issuer ID, key ID and one-time
downloaded `.p8` private key. This API key is for upload, not APNs, and is not
the certificate private key. Never commit or print any of these credentials.

Set these repository secrets (base64 means one unwrapped base64 encoding of the
binary file; do not include filenames or shell syntax):

| Secret | Value |
| --- | --- |
| `APPLE_TEAM_ID` | 10-character Apple Developer Team ID |
| `APPLE_CERTIFICATE_BASE64` | PKCS#12 containing both signing identities and private keys |
| `APPLE_CERTIFICATE_PASSWORD` | PKCS#12 export password |
| `APPLE_IOS_PROFILE_BASE64` | iOS App Store app profile, base64 binary `.mobileprovision` |
| `APPLE_IOS_SHARE_PROFILE_BASE64` | iOS App Store share extension profile, base64 binary |
| `APPLE_MAC_PROFILE_BASE64` | Mac App Store app profile, base64 binary `.provisionprofile` |
| `APPLE_MAC_SHARE_PROFILE_BASE64` | Mac App Store share extension profile, base64 binary |
| `ASC_KEY_ID` | App Store Connect team API key ID |
| `ASC_ISSUER_ID` | App Store Connect issuer UUID |
| `ASC_PRIVATE_KEY` | Complete original `.p8` PEM text, including header/footer and newlines |

Protect access to repository secrets and the default branch, and rotate expired
certificates/profiles. App Store Connect API keys can be broader than a single
app; use the narrowest role Apple permits and monitor/revoke if compromised.
The macOS installer certificate selection and current Xcode export method must
be verified in a real authorized release. No upload, signing resource creation,
or credential setup is performed by adding these files.
