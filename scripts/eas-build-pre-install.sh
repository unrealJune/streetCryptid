#!/usr/bin/env bash

set -euo pipefail

platform="${EAS_BUILD_PLATFORM:-local}"
if [[ "$platform" != "ios" && "$platform" != "android" ]]; then
  echo "Skipping iroh native build for $platform."
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate_dir="$repo_root/modules/iroh-location/rust"
target_dir="${CARGO_TARGET_DIR:-$crate_dir/target}"
if [[ "$target_dir" != /* ]]; then
  target_dir="$crate_dir/$target_dir"
fi
export CARGO_TARGET_DIR="$target_dir"

# shellcheck source=scripts/build-profile.sh
source "$repo_root/scripts/build-profile.sh"

# Which Android ABIs to produce. A release must ship all three; a pull-request build only has to
# install on a test phone, and every one of those is arm64 -- armeabi-v7a is dead hardware and
# x86_64 is emulator-only, so building them triples the Rust work for nothing. The workflows set
# this; the default stays the full set so a local run and a release behave the same.
SC_ANDROID_ABIS="${SC_ANDROID_ABIS:-arm64-v8a armeabi-v7a x86_64}"

# Where prebuilt native artifacts are staged between runs. This is a plain build-output cache: the
# .so / .xcframework and the UniFFI bindings generated alongside them, all derived from source in
# this repository. No credential is involved at any point in this script -- signing happens later,
# inside Xcode and Gradle.
native_cache_root="${SC_NATIVE_CACHE_DIR:-$HOME/.cache/streetcryptid/native}"

if command -v sha256sum > /dev/null 2>&1; then
  SHA_CMD=(sha256sum)
else
  SHA_CMD=(shasum -a 256)
fi

# Identity of a native build: the crate sources, the exact compiler, and the two scripts that
# decide how they are compiled. Paths are kept RELATIVE on purpose -- the warm job on main runs
# from $GITHUB_WORKSPACE while this hook runs from the copy EAS makes under runner.temp, and an
# absolute path in the hash input would make those two never agree.
compute_digest() {
  {
    rustc -V 2> /dev/null || echo 'rustc-unknown'
    printf 'profile-v1\n'
    (
      cd "$crate_dir"
      find src third_party Cargo.toml Cargo.lock -type f |
        LC_ALL=C sort |
        tr '\n' '\0' |
        xargs -0 "${SHA_CMD[@]}"
    )
    (
      cd "$repo_root"
      "${SHA_CMD[@]}" scripts/eas-build-pre-install.sh scripts/generate-uniffi-bindings.sh
    )
  } | "${SHA_CMD[@]}" | cut -c1-40
}

# Only phase marks here, no sampler: scripts/eas-local-build-ci.sh runs one around the WHOLE
# `eas build --local` invocation, and a second one would double-count this hook's own processes.

toolchain_start="$(date +%s)"
if ! command -v rustup > /dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    https://sh.rustup.rs | sh -s -- -y --profile minimal
fi

# A rustup installed by this hook is not on the inherited PATH yet.
export PATH="$HOME/.cargo/bin:$PATH"
rustup toolchain install stable --profile minimal --no-self-update
export RUSTUP_TOOLCHAIN=stable
sc_profile_mark 'rust-toolchain' "$(($(date +%s) - toolchain_start))"

digest="$(compute_digest)"
stage="$native_cache_root/$platform/$digest"

if [[ "$platform" == "android" ]]; then
  jni_libs="$repo_root/modules/iroh-location/android/src/main/jniLibs"
  bindings_dir="$repo_root/modules/iroh-location/android/src/main/java/uniffi"

  abi_target() {
    case "$1" in
      arm64-v8a) printf 'aarch64-linux-android' ;;
      armeabi-v7a) printf 'armv7-linux-androideabi' ;;
      x86_64) printf 'x86_64-linux-android' ;;
      x86) printf 'i686-linux-android' ;;
      *)
        echo "Unsupported Android ABI: $1" >&2
        exit 1
        ;;
    esac
  }

  # A hit needs every ABI this build was asked for AND the bindings that were generated with them.
  # The warm job on main stages all three, so a pull request asking for arm64-v8a alone hits the
  # same entry; the reverse (a release after a PR staged one ABI) correctly misses.
  cache_hit=1
  [[ -d "$stage/bindings" ]] || cache_hit=0
  for abi in $SC_ANDROID_ABIS; do
    [[ -f "$stage/$abi/libiroh_location.so" ]] || cache_hit=0
  done

  if ((cache_hit)); then
    sc_profile_note 'native_artifacts' "reused-$digest"
    mkdir -p "$jni_libs" "$(dirname "$bindings_dir")"
    for abi in $SC_ANDROID_ABIS; do
      mkdir -p "$jni_libs/$abi"
      cp "$stage/$abi/libiroh_location.so" "$jni_libs/$abi/"
    done
    rm -rf "$bindings_dir"
    cp -R "$stage/bindings" "$bindings_dir"
    exit 0
  fi

  sc_profile_note 'native_artifacts' "built-$digest"
  sc_profile_run 'uniffi-bindgen' "$repo_root/scripts/generate-uniffi-bindings.sh" android

  targets=()
  ndk_args=()
  for abi in $SC_ANDROID_ABIS; do
    targets+=("$(abi_target "$abi")")
    ndk_args+=(-t "$abi")
  done
  sc_profile_run 'rust-target-add' rustup target add --toolchain stable "${targets[@]}"

  if ! command -v cargo-ndk > /dev/null 2>&1; then
    sc_profile_run 'cargo-ndk-install' \
      cargo +stable install cargo-ndk --version 4.1.2 --locked
  fi

  (
    cd "$crate_dir"
    sc_profile_run 'cargo-build' \
      cargo +stable ndk "${ndk_args[@]}" -o "$jni_libs" build --locked --release --timings
  )
  sc_profile_collect_cargo_timings

  # Stage what was just built so the next run -- and, from the main-branch warm job, every open
  # pull request -- can skip all of the above.
  rm -rf "$stage"
  mkdir -p "$stage"
  for abi in $SC_ANDROID_ABIS; do
    mkdir -p "$stage/$abi"
    cp "$jni_libs/$abi/libiroh_location.so" "$stage/$abi/"
  done
  cp -R "$bindings_dir" "$stage/bindings"
  exit 0
fi

ios_dir="$repo_root/modules/iroh-location/ios"
headers_dir="$ios_dir/headers"
framework_path="$ios_dir/IrohLocationFFI.xcframework"
bindings_dir="$ios_dir/generated"
library_path="$target_dir/aarch64-apple-ios/release/libiroh_location.a"

# Keep C/assembly dependencies built by Rust aligned with Expo SDK 57's iOS minimum.
export IPHONEOS_DEPLOYMENT_TARGET=16.4

if [[ -d "$stage/IrohLocationFFI.xcframework" && -d "$stage/headers" && -d "$stage/bindings" ]]; then
  sc_profile_note 'native_artifacts' "reused-$digest"
  rm -rf "$framework_path" "$headers_dir" "$bindings_dir"
  cp -R "$stage/IrohLocationFFI.xcframework" "$framework_path"
  cp -R "$stage/headers" "$headers_dir"
  cp -R "$stage/bindings" "$bindings_dir"
  exit 0
fi

sc_profile_note 'native_artifacts' "built-$digest"

# Keep the committed Swift source and C header synchronized with the Rust archive built below.
# UniFFI validates every API checksum on first use and aborts when generated bindings are stale.
sc_profile_run 'uniffi-bindgen' "$repo_root/scripts/generate-uniffi-bindings.sh" ios

sc_profile_run 'rust-target-add' rustup target add --toolchain stable aarch64-apple-ios
sc_profile_run 'cargo-build' \
  cargo +stable build \
  --locked \
  --manifest-path "$crate_dir/Cargo.toml" \
  --release \
  --target aarch64-apple-ios \
  --timings
sc_profile_collect_cargo_timings

rm -rf "$headers_dir" "$framework_path"
mkdir -p "$headers_dir"
cp "$bindings_dir/iroh_locationFFI.h" "$headers_dir/"
cp "$bindings_dir/iroh_locationFFI.modulemap" "$headers_dir/module.modulemap"

sc_profile_run 'create-xcframework' \
  xcodebuild -create-xcframework \
  -library "$library_path" \
  -headers "$headers_dir" \
  -output "$framework_path"

rm -rf "$stage"
mkdir -p "$stage"
cp -R "$framework_path" "$stage/IrohLocationFFI.xcframework"
cp -R "$headers_dir" "$stage/headers"
cp -R "$bindings_dir" "$stage/bindings"
