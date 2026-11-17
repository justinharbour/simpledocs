#!/usr/bin/env bash
# Structural guard for the security-sensitive SimpleDocsConnected package.
# Run from anywhere inside the repository. Any violation fails the build. To change a rule, edit this
# file in a reviewed PR: that is the point of the gate.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
pkg="native/Packages/SimpleDocsConnected"
failed=0

fail() {
  echo "::error title=SimpleDocsConnected guard::$1"
  failed=1
}

for required in "$pkg/Package.swift" "$pkg/Sources/SimpleDocsConnected" "$pkg/Tests/SimpleDocsConnectedTests"; do
  [ -e "$required" ] || fail "Missing $required. The package must stay present and tested."
done
[ "$failed" = 0 ] || exit 1

# 1. Only the connected app's shared experimental UI may invoke these packages.
#    The word boundary keeps the unrelated SimpleDocsConnectedApp type from matching.
referrers="$(grep -rIlE '\bSimpleDocsConnected\b' native \
  --exclude-dir=.build --exclude-dir=.swiftpm --exclude-dir=DerivedData \
  --exclude-dir=SimpleDocsConnected --exclude-dir=SimpleDocsOAuth --exclude-dir=ConnectedShared --exclude-dir=ConnectedApp --exclude-dir=docs --exclude-dir='*.xcodeproj' --exclude='project.yml' || true)"
if [ -n "$referrers" ]; then
  fail "SimpleDocsConnected is referenced outside its package (linking needs a reviewed change to this guard): $(echo "$referrers" | tr '\n' ' ')"
fi
oauth_referrers="$(grep -rIlE '\bSimpleDocsOAuth\b' native \
  --exclude-dir=.build --exclude-dir=.swiftpm --exclude-dir=DerivedData \
  --exclude-dir=SimpleDocsOAuth --exclude-dir=SimpleDocsConnected --exclude-dir=ConnectedShared --exclude-dir=ConnectedApp --exclude-dir=docs --exclude-dir='*.xcodeproj' --exclude='project.yml' || true)"
if [ -n "$oauth_referrers" ]; then
  fail "SimpleDocsOAuth is referenced outside its package: $(echo "$oauth_referrers" | tr '\n' ' ')"
fi
# The direct-provider edition must not gain a dependency on the connected client.
if sed -n '/^  SimpleDocsMacDirect:/,/^  SimpleDocsiOS:/p' native/project.yml | grep -qE 'SimpleDocsConnected|SimpleDocsOAuth|ConnectedShared'; then
  fail 'Direct edition references connected-client packages.'
fi

# 2. No dependencies of any kind.
if grep -nE '\.package\(' "$pkg/Package.swift"; then
  fail "Package.swift declares a dependency. This package must stay dependency-free."
fi

# 3. No networking, credential storage or sign-in machinery. Native auth is unverified and blocked.
forbidden='URLSession|URLRequest|CFNetwork|NWConnection|NWPath|SecItem|ASWebAuthentication|import +(Network|Security|AuthenticationServices|LocalAuthentication|WebKit|SafariServices)\b'
if grep -rnE "$forbidden" "$pkg/Sources"; then
  fail "Networking, credential storage or sign-in API found in $pkg/Sources. Native authentication is not verified; do not add it here."
fi

# 4. Nothing may add a verified auth or trust state without changing this guard in review.
if grep -rnE 'case +(verified|trusted|authenticated|signedIn)\b' "$pkg/Sources"; then
  fail "A verified/trusted auth state was added. This requires a verified, security-reviewed flow and a reviewed change to this guard."
fi

if [ "$failed" = 0 ]; then
  echo "SimpleDocsConnected guard passed: experimental app use is limited to ConnectedShared; core remains dependency-free with no networking or auth APIs."
fi
exit "$failed"
