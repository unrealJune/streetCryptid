#!/usr/bin/env bash
# Only signed, notarized universal apps reach the update feed. No unsigned fallback.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
version="${1:?version}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 2
: "${MACOS_SIGN_IDENTITY:?Developer ID Application identity required}"
: "${MACOS_NOTARY_PROFILE:?notarytool keychain profile required}"
: "${MACOS_SPARKLE_PUBLIC_KEY:?Sparkle public key required}"
: "${MACOS_SPARKLE_PRIVATE_KEY_FILE:?Sparkle private key file required}"
app="$root/repeater/macos/artifacts/universal/streetCryptid Repeater.app"
out="$root/repeater/macos/artifacts/release-$version"
mkdir -p "$out"

APP="$app" VERSION="$version" python3 - <<'PY'
import os, plistlib
with open(os.path.join(os.environ["APP"], "Contents/Info.plist"), "rb") as file:
    info = plistlib.load(file)
assert info["CFBundleVersion"] == os.environ["VERSION"], "Wrong app version"
assert info["SUPublicEDKey"] == os.environ["MACOS_SPARKLE_PUBLIC_KEY"], "Wrong update key"
PY
sparkle="$app/Contents/Frameworks/Sparkle.framework/Versions/B"
sign() { codesign --force --timestamp --options runtime --sign "$MACOS_SIGN_IDENTITY" "$1"; }
# Sign from the leaves inward, never --deep for distribution.
sign "$sparkle/Autoupdate"
sign "$sparkle/Updater.app"
for service in "$sparkle"/XPCServices/*.xpc; do sign "$service"; done
sign "$app/Contents/Frameworks/Sparkle.framework"
sign "$app/Contents/Resources/streetcryptid-repeater-host"
sign "$app"
codesign --verify --deep --strict "$app"
for binary in "$app/Contents/MacOS/StreetCryptidRepeater" "$app/Contents/Resources/streetcryptid-repeater-host"; do
  lipo "$binary" -verify_arch arm64 x86_64
done
ditto -c -k --keepParent "$app" "$out/notarization.zip"
notary_args=(--keychain-profile "$MACOS_NOTARY_PROFILE")
if [[ -n "${MACOS_SIGN_KEYCHAIN:-}" ]]; then
  notary_args+=(--keychain "$MACOS_SIGN_KEYCHAIN")
fi
xcrun notarytool submit "$out/notarization.zip" "${notary_args[@]}" --wait --timeout 30m
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute "$app"
rm "$out/notarization.zip"

archive="streetcryptid-repeater-${version}-universal-macos.zip"
ditto -c -k --keepParent "$app" "$out/$archive"
tools="$root/repeater/macos/.build/artifacts/sparkle/Sparkle/bin"
"$tools/generate_appcast" --ed-key-file "$MACOS_SPARKLE_PRIVATE_KEY_FILE" \
  --download-url-prefix "https://github.com/unrealJune/streetCryptid/releases/download/macos-v${version}/" \
  "$out"
# Full corresponding source: includes every workspace manifest and all shared build inputs.
git archive --format=tar.gz --prefix="streetcryptid-repeater-$version-source/" \
  --output="$out/streetcryptid-repeater-$version-source.tar.gz" HEAD
(cd "$out" && shasum -a 256 "$archive" "streetcryptid-repeater-$version-source.tar.gz" > SHA256SUMS)
printf 'Release assets: %s\n' "$out"
