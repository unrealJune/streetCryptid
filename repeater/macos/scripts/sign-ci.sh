#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${RUNNER_TEMP:?Run this only on a disposable CI runner}"
: "${MACOS_CERTIFICATE_P12:?}"
: "${MACOS_CERTIFICATE_PASSWORD:?}"
: "${MACOS_NOTARY_KEY:?}"
: "${MACOS_NOTARY_KEY_ID:?}"
: "${MACOS_NOTARY_ISSUER:?}"
: "${MACOS_SPARKLE_PRIVATE_KEY:?}"
work="$(mktemp -d "$RUNNER_TEMP/sc-macos-sign.XXXXXX")"
export MACOS_SIGN_KEYCHAIN="$work/signing.keychain-db"
export MACOS_SPARKLE_PRIVATE_KEY_FILE="$work/sparkle.key"
export MACOS_NOTARY_PROFILE=streetcryptid-repeater
export SIGN_WORK="$work"
password="$(openssl rand -hex 32)"
cleanup() {
  security delete-keychain "$MACOS_SIGN_KEYCHAIN" >/dev/null 2>&1 || true
  rm -f "$work/certificate.p12" "$work/notary.p8" "$work/sparkle.key"
  rmdir "$work" 2>/dev/null || true
}
trap cleanup EXIT
python3 - <<'PY'
import base64, os
from pathlib import Path
work = Path(os.environ["SIGN_WORK"])
(work / "certificate.p12").write_bytes(base64.b64decode(os.environ["MACOS_CERTIFICATE_P12"], validate=True))
(work / "notary.p8").write_text(os.environ["MACOS_NOTARY_KEY"])
(work / "sparkle.key").write_text(os.environ["MACOS_SPARKLE_PRIVATE_KEY"])
PY
security create-keychain -p "$password" "$MACOS_SIGN_KEYCHAIN"
security set-keychain-settings -lut 3600 "$MACOS_SIGN_KEYCHAIN"
security unlock-keychain -p "$password" "$MACOS_SIGN_KEYCHAIN"
security import "$work/certificate.p12" -k "$MACOS_SIGN_KEYCHAIN" -P "$MACOS_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$MACOS_SIGN_KEYCHAIN" >/dev/null
security list-keychains -d user -s "$MACOS_SIGN_KEYCHAIN"
xcrun notarytool store-credentials "$MACOS_NOTARY_PROFILE" --keychain "$MACOS_SIGN_KEYCHAIN" \
  --key "$work/notary.p8" --key-id "$MACOS_NOTARY_KEY_ID" --issuer "$MACOS_NOTARY_ISSUER" >/dev/null
bash repeater/macos/scripts/package.sh "${1:?version}"
