#!/bin/bash
set -euo pipefail
umask 077

: "${RUNNER_TEMP:?}" "${PLATFORM:?}" "${RELEASE_VERSION:?}" "${BUILD_NUMBER:?}"
: "${APPLE_TEAM_ID:?}" "${APPLE_CERTIFICATE_BASE64:?}" "${APPLE_CERTIFICATE_PASSWORD:?}"
: "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_PRIVATE_KEY:?}"
[[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]]
[[ "$APPLE_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]]
[[ "$ASC_KEY_ID" =~ ^[A-Z0-9]+$ ]]

work="$(mktemp -d "$RUNNER_TEMP/simpledocs-signing.XXXXXX")"
keychain="$work/signing.keychain-db"
profiles="$HOME/Library/MobileDevice/Provisioning Profiles"
installed=()
old_keychains=()
while IFS= read -r line; do
  line="${line#\"}"
  line="${line%\"}"
  old_keychains+=("$line")
done < <(security list-keychains -d user | sed -E 's/^[[:space:]]+//')
cleanup() {
  for file in "${installed[@]}"; do rm -f "$file"; done
  if ((${#old_keychains[@]})); then security list-keychains -d user -s "${old_keychains[@]}" || true; fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

case "$PLATFORM" in
  ios)
    : "${APPLE_IOS_PROFILE_BASE64:?}" "${APPLE_IOS_SHARE_PROFILE_BASE64:?}"
    scheme=SimpleDocsiOS; destination='generic/platform=iOS'; ext=ipa
    app_profile="$APPLE_IOS_PROFILE_BASE64"; share_profile="$APPLE_IOS_SHARE_PROFILE_BASE64"
    ;;
  macos)
    : "${APPLE_MAC_PROFILE_BASE64:?}" "${APPLE_MAC_SHARE_PROFILE_BASE64:?}"
    scheme=SimpleDocsMacConnected; destination='generic/platform=macOS'; ext=pkg
    app_profile="$APPLE_MAC_PROFILE_BASE64"; share_profile="$APPLE_MAC_SHARE_PROFILE_BASE64"
    ;;
  *) exit 1 ;;
esac

printf '%s' "$APPLE_CERTIFICATE_BASE64" | base64 --decode > "$work/certificate.p12"
keychain_password="$(openssl rand -hex 24)"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/certificate.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productbuild -T /usr/bin/productsign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain"
mkdir -p "$profiles"
install_profile() {
  local encoded="$1" label="$2" uuid
  printf '%s' "$encoded" | base64 --decode > "$work/$label.mobileprovision"
  security cms -D -i "$work/$label.mobileprovision" > "$work/$label.plist"
  uuid=$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$work/$label.plist")
  [[ "$uuid" =~ ^[A-Fa-f0-9-]+$ ]]
  [[ ! -e "$profiles/$uuid.mobileprovision" ]]
  cp "$work/$label.mobileprovision" "$profiles/$uuid.mobileprovision"
  installed+=("$profiles/$uuid.mobileprovision")
  printf '%s' "$uuid" > "$work/$label.uuid"
}
install_profile "$app_profile" app
install_profile "$share_profile" share
app_uuid=$(cat "$work/app.uuid")
share_uuid=$(cat "$work/share.uuid")

# Distribution APNs must be production, not the development entitlement in the source tree.
cp native/Config/iOS.entitlements "$work/ios.entitlements"
cp native/Config/MacConnected.entitlements "$work/mac.entitlements"
/usr/libexec/PlistBuddy -c 'Set :aps-environment production' "$work/ios.entitlements"
/usr/libexec/PlistBuddy -c 'Set :com.apple.developer.aps-environment production' "$work/mac.entitlements"
cd native
xcodegen generate --spec project-release.yml
xcodebuild -project SimpleDocs.xcodeproj -scheme "$scheme" -configuration Release \
  -destination "$destination" -archivePath "$work/SimpleDocs.xcarchive" archive \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" SIMPLEDOCS_MARKETING_VERSION="$RELEASE_VERSION" \
  SIMPLEDOCS_BUILD_NUMBER="$BUILD_NUMBER" SIMPLEDOCS_IOS_PROFILE="$app_uuid" \
  SIMPLEDOCS_IOS_SHARE_PROFILE="$share_uuid" SIMPLEDOCS_MAC_PROFILE="$app_uuid" \
  SIMPLEDOCS_MAC_SHARE_PROFILE="$share_uuid" SIMPLEDOCS_IOS_ENTITLEMENTS="$work/ios.entitlements" \
  SIMPLEDOCS_MAC_ENTITLEMENTS="$work/mac.entitlements" OTHER_CODE_SIGN_FLAGS="--keychain $keychain"

cat > "$work/export.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>export</string>
<key>signingStyle</key><string>manual</string>
<key>teamID</key><string>$APPLE_TEAM_ID</string>
<key>provisioningProfiles</key><dict>
<key>com.justinharbour.simpledocs</key><string>$app_uuid</string>
<key>com.justinharbour.simpledocs.share</key><string>$share_uuid</string>
</dict></dict></plist>
EOF
xcodebuild -exportArchive -archivePath "$work/SimpleDocs.xcarchive" -exportPath "$work/export" -exportOptionsPlist "$work/export.plist"
shopt -s nullglob
packages=("$work/export/"*.$ext)
[[ ${#packages[@]} -eq 1 ]]
mkdir -p "$work/private_keys"
printf '%s\n' "$ASC_PRIVATE_KEY" > "$work/private_keys/AuthKey_${ASC_KEY_ID}.p8"
API_PRIVATE_KEYS_DIR="$work/private_keys" xcrun altool --upload-app -f "${packages[0]}" \
  --type "$([ "$PLATFORM" = ios ] && printf ios || printf macos)" --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID"
