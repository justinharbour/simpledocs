# Native releases

This workflow depends on the unified native project in draft #68, including its
two share extensions, version build settings and `com.justinharbour.simpledocs`
identifiers. Merge and reconcile that project before enabling releases. It does
not release the older separate Direct application. No tvOS target exists; add
one and its real signing configuration when it does, rather than claiming a
tvOS release today.

## GitHub setup and flow

The `main` push workflow runs release-please against the root manifest. It
opens a conventional-title release PR to `main`; merge it through the normal
review and CI process. On the subsequent `main` push release-please creates the
GitHub tag/release and, in the same workflow run, starts both TestFlight jobs
at the exact release SHA. A GitHub release means the tag was created, **not**
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
Apple secrets are used only by the main-branch release jobs, never PR jobs.

`version.txt` and `.release-please-manifest.json` start at 0.0.0, not a claim
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
