#!/usr/bin/env bash
# Build the CURRENT checkout as a signed Release and install it on the field-soak iPhone, in place
# (account, pairings and history survive). Reads FIELD_SOAK_TEAM_ID / FIELD_SOAK_UDID from
# scripts/field-soak/.env. Release bundles the JS, so no Metro is needed; `.env.local` at the repo
# root must carry the EXPO_PUBLIC_* telemetry variables or the phone is invisible to `fs check`.
#
# Usage: scripts/field-soak/build-install.sh [--rust]
#   --rust  rebuild the iOS XCFramework first (`just bindgen-ios`); needed whenever the Rust crate
#           changed. The script refuses to go on if that leaves the generated bindings dirty.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
set -a
# shellcheck disable=SC1091
[ -f "$HERE/.env" ] && . "$HERE/.env"
set +a
: "${FIELD_SOAK_TEAM_ID:?set FIELD_SOAK_TEAM_ID in scripts/field-soak/.env}"
: "${FIELD_SOAK_UDID:?set FIELD_SOAK_UDID in scripts/field-soak/.env}"
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
cd "$REPO"

if [ "${1:-}" = --rust ]; then
  just bindgen-ios
  if ! git diff --quiet -- modules/iroh-location/ios/generated; then
    echo "error: regenerated Swift bindings differ from the committed ones" >&2
    exit 1
  fi
fi
[ -d ios ] || CI=1 bunx expo prebuild -p ios
(cd ios && pod install)

xcodebuild -workspace ios/streetCryptid.xcworkspace -scheme streetCryptid -configuration Release \
  -destination "id=$FIELD_SOAK_UDID" -derivedDataPath ios/build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM="$FIELD_SOAK_TEAM_ID" CODE_SIGN_STYLE=Automatic build -quiet

xcrun devicectl device install app --device "$FIELD_SOAK_UDID" \
  ios/build/Build/Products/Release-iphoneos/streetCryptid.app
"$HERE/fs" launch "installed $(git rev-parse --short HEAD)"
