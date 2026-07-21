#!/usr/bin/env bash

set -euo pipefail

platform="${1:-all}"
if [[ "$platform" != "all" && "$platform" != "android" && "$platform" != "ios" ]]; then
  echo "Usage: $0 [all|android|ios]" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate_dir="$repo_root/modules/iroh-location/rust"
kotlin_out_dir="${UNIFFI_KOTLIN_OUT_DIR:-$repo_root/modules/iroh-location/android/src/main/java}"
swift_out_dir="${UNIFFI_SWIFT_OUT_DIR:-$repo_root/modules/iroh-location/ios/generated}"
target_dir="${CARGO_TARGET_DIR:-$crate_dir/target}"

if [[ "$target_dir" != /* ]]; then
  target_dir="$crate_dir/$target_dir"
fi
export CARGO_TARGET_DIR="$target_dir"

run_cargo() {
  if [[ -n "${RUSTUP_TOOLCHAIN:-}" ]]; then
    cargo "+${RUSTUP_TOOLCHAIN}" "$@"
  else
    cargo "$@"
  fi
}

case "$(uname -s)" in
  Darwin) host_library="$target_dir/debug/libiroh_location.dylib" ;;
  Linux) host_library="$target_dir/debug/libiroh_location.so" ;;
  MINGW* | MSYS* | CYGWIN*) host_library="$target_dir/debug/iroh_location.dll" ;;
  *)
    echo "Unsupported host for UniFFI binding generation: $(uname -s)" >&2
    exit 1
    ;;
esac

(
  cd "$crate_dir"
  run_cargo build --locked --features cli

  generate() {
    local language="$1"
    local out_dir="$2"
    mkdir -p "$out_dir"
    run_cargo run \
      --locked \
      --bin uniffi-bindgen \
      --features cli \
      -- \
      generate \
      --library "$host_library" \
      --crate iroh_location \
      --language "$language" \
      --no-format \
      --out-dir "$out_dir"
  }

  if [[ "$platform" == "all" || "$platform" == "android" ]]; then
    generate kotlin "$kotlin_out_dir"
  fi
  if [[ "$platform" == "all" || "$platform" == "ios" ]]; then
    generate swift "$swift_out_dir"
  fi
)
