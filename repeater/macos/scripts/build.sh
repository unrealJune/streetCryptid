#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$root"
version="${1:-0.0.0}"
arch="${2:-universal}"
prebuilt_hosts="${3:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Expected MAJOR.MINOR.PATCH" >&2; exit 2; }
case "$arch" in
  universal) arches=(arm64 x86_64) ;;
  arm64 | x86_64) arches=("$arch") ;;
  *) echo "Expected universal, arm64 or x86_64" >&2; exit 2 ;;
esac

export MACOSX_DEPLOYMENT_TARGET=13.0
export REPEATER_VERSION="$version"
out="$root/repeater/macos/artifacts/$arch"
app="$out/streetCryptid Repeater.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/Frameworks"
swift_args=()
hosts=()
for cpu in "${arches[@]}"; do
  swift_args+=(--arch "$cpu")
  target=x86_64-apple-darwin
  [[ "$cpu" != arm64 ]] || target=aarch64-apple-darwin
  if [[ -n "$prebuilt_hosts" ]]; then
    host="$prebuilt_hosts/$target/streetcryptid-repeater-host"
    [[ -s "$host" ]] && lipo "$host" -verify_arch "$cpu" || { echo "Missing or invalid $cpu host" >&2; exit 1; }
    hosts+=("$host")
  else
    cargo build --locked --profile desktop-release -p streetcryptid-repeater-host --target "$target"
    hosts+=("${CARGO_TARGET_DIR:-$root/target}/$target/desktop-release/streetcryptid-repeater-host")
  fi
done

swift build --package-path repeater/macos --configuration release "${swift_args[@]}" --force-resolved-versions --product StreetCryptidRepeater
bin="$(swift build --package-path repeater/macos --configuration release "${swift_args[@]}" --show-bin-path)"
install -m 0755 "$bin/StreetCryptidRepeater" "$app/Contents/MacOS/StreetCryptidRepeater"
if [[ "$arch" == universal ]]; then
  lipo -create "${hosts[@]}" -output "$app/Contents/Resources/streetcryptid-repeater-host"
else
  install -m 0755 "${hosts[0]}" "$app/Contents/Resources/streetcryptid-repeater-host"
fi

framework="$root/repeater/macos/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
[[ -d "$framework" ]] || { echo "Missing pinned Sparkle framework" >&2; exit 1; }
ditto "$framework" "$app/Contents/Frameworks/Sparkle.framework"
install_name_tool -add_rpath @executable_path/../Frameworks "$app/Contents/MacOS/StreetCryptidRepeater"
cp repeater/macos/Resources/Info.plist "$app/Contents/Info.plist"
VERSION="$version" APP="$app" python3 - <<'PY'
import base64, os, plistlib
path = os.path.join(os.environ["APP"], "Contents/Info.plist")
with open(path, "rb") as source:
    info = plistlib.load(source)
info["CFBundleVersion"] = info["CFBundleShortVersionString"] = os.environ["VERSION"]
key = os.environ.get("MACOS_SPARKLE_PUBLIC_KEY", "")
if key and len(base64.b64decode(key, validate=True)) != 32:
    raise SystemExit("Sparkle public key must encode 32 bytes")
info["SUPublicEDKey"] = key
with open(path, "wb") as dest:
    plistlib.dump(info, dest)
PY
cp assets/images/mothman-logo.svg "$app/Contents/Resources/"
cp repeater/windows/app/Assets/{Plex.ttf,Rajdhani.ttf,Plex-LICENSE.txt,Rajdhani-LICENSE.txt} "$app/Contents/Resources/"
cp LICENSE repeater/macos/NOTICE "$app/Contents/Resources/"
install -m 0644 repeater/macos/.build/checkouts/Sparkle/LICENSE "$app/Contents/Resources/Sparkle-LICENSE"
git rev-parse HEAD > "$app/Contents/Resources/SOURCE_COMMIT"
iconset="$out/Repeater.iconset"
swift run --package-path repeater/macos --configuration release --force-resolved-versions \
  RepeaterIconTool assets/images/mothman-logo.svg "$out"
install -m 0644 "$out/MothmanTemplate.png" "$out/MothmanMark.png" "$app/Contents/Resources/"
iconutil -c icns "$iconset" -o "$app/Contents/Resources/Repeater.icns"
# Local builds are ad-hoc only. The release step replaces this with Developer ID signatures.
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
for cpu in "${arches[@]}"; do
  lipo "$app/Contents/MacOS/StreetCryptidRepeater" -verify_arch "$cpu"
  lipo "$app/Contents/Resources/streetcryptid-repeater-host" -verify_arch "$cpu"
done
printf 'Built %s\n' "$app"
