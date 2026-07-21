#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/streetcryptid-bindings.XXXXXX")"
trap 'rm -rf "$temp_dir"' EXIT

UNIFFI_KOTLIN_OUT_DIR="$temp_dir/android" \
  UNIFFI_SWIFT_OUT_DIR="$temp_dir/ios" \
  "$repo_root/scripts/generate-uniffi-bindings.sh" all

status=0
compare_binding() {
  local tracked="$1"
  local generated="$2"
  if cmp -s "$tracked" "$generated"; then
    return
  fi

  echo "Stale UniFFI binding: ${tracked#"$repo_root/"}" >&2
  diff -u "$tracked" "$generated" >&2 || true
  status=1
}

compare_binding \
  "$repo_root/modules/iroh-location/android/src/main/java/uniffi/iroh_location/iroh_location.kt" \
  "$temp_dir/android/uniffi/iroh_location/iroh_location.kt"
compare_binding \
  "$repo_root/modules/iroh-location/ios/generated/iroh_location.swift" \
  "$temp_dir/ios/iroh_location.swift"
compare_binding \
  "$repo_root/modules/iroh-location/ios/generated/iroh_locationFFI.h" \
  "$temp_dir/ios/iroh_locationFFI.h"
compare_binding \
  "$repo_root/modules/iroh-location/ios/generated/iroh_locationFFI.modulemap" \
  "$temp_dir/ios/iroh_locationFFI.modulemap"

if ((status != 0)); then
  echo "Run 'just bindgen-android' and 'just bindgen-ios' to refresh tracked bindings." >&2
  exit "$status"
fi

echo "Tracked UniFFI bindings match the Rust API."
