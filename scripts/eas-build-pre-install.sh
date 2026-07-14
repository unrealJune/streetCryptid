#!/usr/bin/env bash

set -euo pipefail

platform="${EAS_BUILD_PLATFORM:-local}"
if [[ "$platform" != "ios" && "$platform" != "android" ]]; then
  echo "Skipping iroh native build for $platform."
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate_dir="$repo_root/modules/iroh-location/rust"

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    https://sh.rustup.rs | sh -s -- -y --profile minimal
fi

# A rustup installed by this hook is not on the inherited PATH yet.
export PATH="$HOME/.cargo/bin:$PATH"
# Keep C/assembly dependencies built by Rust aligned with Expo SDK 57's iOS minimum.
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-16.4}"

rustup toolchain install stable --profile minimal --no-self-update

if [[ "$platform" == "android" ]]; then
  rustup target add --toolchain stable \
    aarch64-linux-android \
    armv7-linux-androideabi \
    x86_64-linux-android
  if ! command -v cargo-ndk >/dev/null 2>&1; then
    cargo +stable install cargo-ndk --version 4.1.2 --locked
  fi
  (
    cd "$crate_dir"
    cargo +stable ndk \
      -t arm64-v8a \
      -t armeabi-v7a \
      -t x86_64 \
      -o "$repo_root/modules/iroh-location/android/src/main/jniLibs" \
      build \
      --locked \
      --release
  )
  exit 0
fi

ios_dir="$repo_root/modules/iroh-location/ios"
headers_dir="$ios_dir/headers"
framework_path="$ios_dir/IrohLocationFFI.xcframework"
library_path="$crate_dir/target/aarch64-apple-ios/release/libiroh_location.a"

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
