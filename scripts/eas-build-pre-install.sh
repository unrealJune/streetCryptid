#!/usr/bin/env bash

set -euo pipefail

platform="${EAS_BUILD_PLATFORM:-local}"
if [[ "$platform" != "ios" && "$platform" != "android" ]]; then
  echo "Skipping iroh native build for $platform."
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
crate_dir="$repo_root/modules/iroh-location/rust"
# The crate is a member of the root Cargo workspace, whose target directory is the repository's.
target_dir="${CARGO_TARGET_DIR:-$repo_root/target}"
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

# Identity of a native build: the crate sources, everything the workspace feeds into them, the
# exact compiler, and the two scripts that decide how they are compiled. Paths are kept RELATIVE on
# purpose -- the warm job on main runs from $GITHUB_WORKSPACE while this hook runs from the copy EAS
# makes under runner.temp, and an absolute path in the hash input would make those two never agree.
#
# The workspace inputs are the ones a stale .so would otherwise hide: the root Cargo.toml (its
# profiles and [patch.crates-io]), the one Cargo.lock, the patched crates under third_party/, and
# repeater/protocol, which the phone links by path -- a protocol change that reused an old .so
# would ship an old roster rule whose UniFFI checksums still match, with no error anywhere. The
# server is deliberately absent: the phone does not link it.
compute_digest() {
  local compiler sdk ndk
  compiler="$(rustc -vV)" || return
  if [[ "$platform" == android ]]; then
    ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-${ANDROID_NDK:-}}}"
    if [[ -n "$ndk" ]]; then
      sdk="$(grep '^Pkg.Revision *=' "$ndk/source.properties")" || return
    else
      sdk='ndk-unspecified'
    fi
  else
    sdk="$(xcodebuild -version)" || return
  fi
  {
    printf 'profile-v3\n%s\n%s\n' "$compiler" "$sdk"
    (
      cd "$crate_dir"
      find src third_party Cargo.toml -type f |
        LC_ALL=C sort |
        tr '\n' '\0' |
        xargs -0 "${SHA_CMD[@]}"
    )
    (
      cd "$repo_root"
      find Cargo.toml Cargo.lock rust-toolchain.toml third_party repeater/protocol -type f |
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

toolchain="$(sed -n 's/^channel = "\([^"]*\)"$/\1/p' "$repo_root/rust-toolchain.toml")"
[[ -n "$toolchain" ]]
export RUSTUP_TOOLCHAIN="$toolchain"

if [[ "${1:-}" == '--cache-key' ]]; then
  compute_digest
  exit
fi

# Only phase marks here, no sampler: scripts/eas-local-build-ci.sh runs one around the WHOLE
# `eas build --local` invocation, and a second one would double-count this hook's own processes.

if [[ "${1:-}" != '--cache-ready' ]]; then
  toolchain_start="$(date +%s)"
  if ! command -v rustup > /dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
      https://sh.rustup.rs | sh -s -- -y --profile minimal
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
  rustup toolchain install "$toolchain" --profile minimal --no-self-update
  sc_profile_mark 'rust-toolchain' "$(($(date +%s) - toolchain_start))"
fi

digest="$(compute_digest)"
stage="$native_cache_root/$platform/$digest"

cache_ready() {
  local abi
  if [[ "$platform" == android ]]; then
    [[ -s "$stage/bindings/iroh_location/iroh_location.kt" ]] || return 1
    for abi in $SC_ANDROID_ABIS; do
      [[ -s "$stage/$abi/libiroh_location.so" ]] || return 1
    done
  else
    [[ -s "$stage/IrohLocationFFI.xcframework/Info.plist" &&
       -s "$stage/IrohLocationFFI.xcframework/ios-arm64/libiroh_location.a" &&
       -s "$stage/headers/iroh_locationFFI.h" &&
       -s "$stage/headers/module.modulemap" &&
       -s "$stage/bindings/iroh_location.swift" ]]
  fi
}

if [[ "${1:-}" == '--cache-ready' ]]; then
  cache_ready
  exit
fi

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
  if cache_ready; then
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
  sc_profile_run 'rust-target-add' rustup target add --toolchain "$toolchain" "${targets[@]}"

  if ! command -v cargo-ndk > /dev/null 2>&1; then
    sc_profile_run 'cargo-ndk-install' \
      cargo install cargo-ndk --version 4.1.2 --locked
  fi

  (
    cd "$crate_dir"
    sc_profile_run 'cargo-build' \
      cargo ndk "${ndk_args[@]}" -o "$jni_libs" build --locked --release --timings
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

if cache_ready; then
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

sc_profile_run 'rust-target-add' rustup target add --toolchain "$toolchain" aarch64-apple-ios
sc_profile_run 'cargo-build' \
  cargo build \
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
