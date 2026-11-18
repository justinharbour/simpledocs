# Push notifications (APNs)

The Worker sends a push to every registered iPhone and Mac when an inbound fax is archived, a voicemail is saved, an outgoing fax or letter reaches `failed`, or the pending-fax alert email goes out. Outgoing failures fire from `mark()` in `web/worker/deliveries.mjs`, only on the transition into `failed`, so a repeat webhook, queue redelivery or cron poll never pushes twice. A voicemail pushes when its recording row is first inserted, so a duplicate event or the transcript event does not. Payloads hold only a generic title and body, a `thread-id` (the kind), and `kind` and `id` fields. They never hold document content or phone numbers.

## How it works

1. After sign-in, the app asks for notification permission and registers with APNs.
2. The device token is POSTed to `/api/push/devices` with the app's own OAuth session. Debug builds send `sandbox`, release builds send `production`.
3. The Worker (`web/worker/push.mjs`) signs an ES256 provider token with the `.p8` key, caches it for 50 minutes, and POSTs to `api.push.apple.com` or `api.sandbox.push.apple.com` depending on the device row. A 410, `Unregistered` or `BadDeviceToken` response deletes the device row.
4. Tapping a notification opens the app and refreshes the record lists. It does not navigate to the record: the apps have no record detail screen yet.

Sending does nothing until the four secrets below exist. Registered devices are kept in the D1 table `push_devices` (migration `0030_push_devices.sql`).

## Owner steps

Apple Developer portal:

1. Identifiers: enable the **Push Notifications** capability on `dev.justinharbour.simpledocs.ios` and `dev.justinharbour.simpledocs.mac.connected`.
2. Keys: create an **Apple Push Notifications service (APNs)** key and download the `.p8`. It can be downloaded only once. Note its Key ID and your Team ID.
3. Regenerate the provisioning profiles for both apps so they carry the push entitlement.

Worker secrets. They are never in `wrangler.jsonc`. `.github/workflows/deploy.yml` uploads `APNS_KEY_P8`, `APNS_KEY_ID` and `APNS_TEAM_ID` on every deploy, the same way it does `TELNYX_*` and `POSTGRID_*`, from GitHub repository secrets of the same names. **Create those three repository secrets before the next deploy, or the deploy step fails** (the action rejects an empty listed secret). `APNS_TOPIC` and `APNS_TOPIC_MACOS` are optional and not in the workflow; set them with `wrangler secret put` only if the bundle IDs differ.

| Secret | Value |
| --- | --- |
| `APNS_KEY_P8` | Full contents of the `.p8` file, including the BEGIN and END lines |
| `APNS_KEY_ID` | The 10 character key ID |
| `APNS_TEAM_ID` | The 10 character team ID |
| `APNS_TOPIC` | Optional. The iOS bundle ID. Defaults to `dev.justinharbour.simpledocs.ios`. |
| `APNS_TOPIC_MACOS` | Optional. Defaults to `dev.justinharbour.simpledocs.mac.connected`. |

Apply migration `0030_push_devices.sql` to D1 before deploying.

## Entitlements

`Config/iOS.entitlements` (`aps-environment`) and `Config/MacConnected.entitlements` (`com.apple.developer.aps-environment`) are set to `development`. Xcode replaces the value from the provisioning profile when signing, so an App Store or TestFlight build gets `production`. No signing, team or bundle ID setting was changed.

## Troubleshooting

- Registration error on a Mac or iPhone: the app ID lacks the Push Notifications capability, or the profile was not regenerated.
- A debug build never receives pushes: its token is `sandbox`. APNs deletes it if sent to the production host, and the Worker uses the environment stored with the token.
- Cloudflare Workers `fetch` is used for the HTTP/2 request. Cloudflare does not document HTTP/2 to arbitrary origins, so the first live push is the real test.
