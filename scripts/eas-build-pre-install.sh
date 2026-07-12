#!/usr/bin/env bash

set -euo pipefail

if [[ "${EAS_BUILD_PLATFORM:-}" != "ios" ]]; then
  echo "Skipping iroh iOS XCFramework build for ${EAS_BUILD_PLATFORM:-local}."
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate_dir="$repo_root/modules/iroh-location/rust"
ios_dir="$repo_root/modules/iroh-location/ios"
headers_dir="$ios_dir/headers"
framework_path="$ios_dir/IrohLocationFFI.xcframework"
library_path="$crate_dir/target/aarch64-apple-ios/release/libiroh_location.a"

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    https://sh.rustup.rs | sh -s -- -y --profile minimal
fi

# rustup may have been installed by this hook and not yet be on PATH.
export PATH="$HOME/.cargo/bin:$PATH"

rustup toolchain install stable --profile minimal --no-self-update
rustup target add --toolchain stable aarch64-apple-ios
cargo +stable build \
  --locked \
  --manifest-path "$crate_dir/Cargo.toml" \
  --release \
  --target aarch64-apple-ios

rm -rf "$headers_dir" "$framework_path"
mkdir -p "$headers_dir"
cp "$ios_dir/generated/iroh_locationFFI.h" "$headers_dir/"
cp "$ios_dir/generated/iroh_locationFFI.modulemap" "$headers_dir/module.modulemap"

xcodebuild -create-xcframework \
  -library "$library_path" \
  -headers "$headers_dir" \
  -output "$framework_path"
