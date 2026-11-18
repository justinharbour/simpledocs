# Push notifications (APNs)

The Worker sends a push to every registered iPhone and Mac when an inbound fax is archived, a voicemail is saved, an outgoing fax or letter reaches `failed`, or the pending-fax alert email goes out. Outgoing failures fire from `mark()` in `web/worker/deliveries.mjs`, only on the transition into `failed`, so a repeat webhook, queue redelivery or cron poll never pushes twice. A voicemail pushes when its recording row is first inserted, so a duplicate event or the transcript event does not. Payloads hold only a generic title and body, a `thread-id` (the kind), and `kind` and `id` fields. They never hold document content or phone numbers.

## How it works

1. After sign-in, the app asks for notification permission and registers with APNs.
2. The device token is POSTed to `/api/push/devices` with the app's own OAuth session and its bundle identifier. Debug builds send `sandbox`, release builds send `production`.
3. The Worker (`web/worker/push.mjs`) signs an ES256 provider token with the `.p8` key, caches it for 50 minutes, and POSTs to `api.push.apple.com` or `api.sandbox.push.apple.com` depending on the device row. Rejections do not delete device rows; a signing or environment configuration error is not proof that a token should be removed.
4. Tapping a notification opens the app and refreshes the screen you are on. It does not navigate to the specific record.

Sending does nothing until the three required secrets below exist. Registered devices are kept in the D1 table `push_devices`.

## Owner steps

Apple Developer portal:

1. Identifiers: verify ownership and enable the **Push Notifications** capability on `com.justinharbour.simpledocs`. Retain any capabilities needed by older installed apps during migration.
2. Keys: create an **Apple Push Notifications service (APNs)** key and download the `.p8`. It can be downloaded only once. Note its Key ID and your Team ID.
3. Prepare platform-appropriate provisioning profiles so they carry the push entitlement.

Worker secrets. They are never in `wrangler.jsonc` or the deploy workflow. Set them once by hand from `web/` with `wrangler secret put <NAME>`; they persist across deploys. `APNS_TOPIC` and `APNS_TOPIC_MACOS` are optional; set them only if the bundle IDs differ.

| Secret | Value |
| --- | --- |
| `APNS_KEY_P8` | Full contents of the `.p8` file, including the BEGIN and END lines |
| `APNS_KEY_ID` | The 10 character key ID |
| `APNS_TEAM_ID` | The 10 character team ID |
| `APNS_TOPIC` | Optional override for legacy iOS registrations. Defaults to `dev.justinharbour.simpledocs.ios`. |
| `APNS_TOPIC_MACOS` | Optional override for legacy macOS registrations. Defaults to `dev.justinharbour.simpledocs.mac.connected`. |

Apply `0030_push_devices.sql` and the additive `0044_push_device_bundle.sql` migration to D1 before deploying.

## Entitlements

`Config/iOS.entitlements` (`aps-environment`) and `Config/MacConnected.entitlements` (`com.apple.developer.aps-environment`) are set to `development`. Xcode replaces the value from the provisioning profile when signing, so an App Store or TestFlight build gets `production`. Signing and team settings remain unconfigured.

## Troubleshooting

- Registration error on a Mac or iPhone: the app ID lacks the Push Notifications capability, or the profile was not regenerated.
- A debug build never receives pushes: its token is `sandbox`. APNs rejects it if sent to the production host, and the Worker uses the environment stored with the token.
- Cloudflare Workers `fetch` is used for the HTTP/2 request. Cloudflare does not document HTTP/2 to arbitrary origins, so the first live push is the real test.

Existing registrations and old clients that omit the bundle identifier continue to use the legacy topic. Explicitly registered previous `com` per-platform topics remain accepted and routed to their recorded topic; new builds register `com.justinharbour.simpledocs`. For all generations to receive push, the APNs key must be authorized for their respective topics. Register the new app normally after installing it; legacy preferences and app-scoped Keychain items do not migrate automatically. Deploy the additive database migration and compatible Worker before installing builds that register the new topic.
