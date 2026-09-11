#!/usr/bin/env bash

# Offline proof that the prebuilt-native-artifact cache in scripts/eas-build-pre-install.sh reuses
# artifacts exactly when it should, and rebuilds whenever it should not.
#
# This cache is the largest build-time win in the pipeline and also the only change in it that can
# be wrong in a way a green build hides: restoring a stale .so produces an app that installs, runs,
# and misbehaves on device. So the interesting assertions here are the NEGATIVE ones -- that a
# changed source, a changed toolchain, or a changed build script all force a rebuild.
#
# The whole thing runs without cargo, the NDK, Xcode, or a network: the toolchain is replaced with
# fakes that record what they were asked to do, against a synthetic source tree. What is under test
# is the cache's decision-making, and that is all shell.
#
# The path-independence check is the subtle one. The main-branch warm job runs this hook from
# $GITHUB_WORKSPACE while a real build runs it from the copy EAS makes under runner.temp. If the
# digest folded an absolute path in, those two would never agree and the cache would miss forever
# while looking like it worked.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
repo_root="$(cd "$repo_root" && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/streetcryptid-native-cache.XXXXXX")"

cleanup() {
  if [[ -d "$test_root" ]]; then
    chmod -R u+w "$test_root" 2> /dev/null || true
    rm -rf -- "$test_root"
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

build_log="$test_root/build-log"
: > "$build_log"

# --- A toolchain that builds nothing and reports everything ------------------

mkdir -p "$test_root/bin"

cat > "$test_root/bin/rustup" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$test_root/bin/rustc" << 'EOF'
#!/usr/bin/env bash
# The toolchain identity is an input to the cache digest, so the test can move it.
echo "rustc ${FAKE_RUSTC_VERSION:-1.90.0} (fake)"
EOF

cat > "$test_root/bin/cargo" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "cargo $*" >> "$FAKE_BUILD_LOG"

args=("$@")
out_dir=''
abis=()
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    -t) abis+=("${args[i + 1]}") ;;
    -o) out_dir="${args[i + 1]}" ;;
  esac
done

if [[ -n "$out_dir" ]]; then
  for abi in "${abis[@]}"; do
    mkdir -p "$out_dir/$abi"
    printf 'so for %s\n' "$abi" > "$out_dir/$abi/libiroh_location.so"
  done
  exit 0
fi

case " $* " in
  *' --target aarch64-apple-ios '*)
    mkdir -p "$CARGO_TARGET_DIR/aarch64-apple-ios/release"
    printf 'static lib\n' > "$CARGO_TARGET_DIR/aarch64-apple-ios/release/libiroh_location.a"
    ;;
esac
exit 0
EOF

cat > "$test_root/bin/xcodebuild" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "xcodebuild $*" >> "$FAKE_BUILD_LOG"
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  if [[ "${args[i]}" == "-output" ]]; then
    mkdir -p "${args[i + 1]}"
    printf 'fake xcframework\n' > "${args[i + 1]}/Info.plist"
  fi
done
EOF

chmod 700 "$test_root/bin/"*

# --- A synthetic source tree -------------------------------------------------

# Only the shapes the hook reads matter: the digest hashes file CONTENT, not Rust.
make_tree() {
  local root="$1"
  mkdir -p \
    "$root/scripts" \
    "$root/modules/iroh-location/rust/src" \
    "$root/modules/iroh-location/rust/third_party/vendored" \
    "$root/modules/iroh-location/android/src/main/java" \
    "$root/modules/iroh-location/ios"

  printf 'pub fn lib() {}\n' > "$root/modules/iroh-location/rust/src/lib.rs"
  printf 'pub fn vendored() {}\n' > "$root/modules/iroh-location/rust/third_party/vendored/lib.rs"
  printf '[package]\nname = "iroh-location"\n' > "$root/modules/iroh-location/rust/Cargo.toml"
  printf '# lockfile\n' > "$root/modules/iroh-location/rust/Cargo.lock"

  cp "$repo_root/scripts/eas-build-pre-install.sh" "$root/scripts/"
  cp "$repo_root/scripts/build-profile.sh" "$root/scripts/"

  # Stands in for the real binding generator, which would need a host cargo build. It writes the
  # files the hook copies around, so the bindings half of the cache is exercised for real.
  cat > "$root/scripts/generate-uniffi-bindings.sh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "bindgen $*" >> "$FAKE_BUILD_LOG"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "android" ]]; then
  out="$root/modules/iroh-location/android/src/main/java/uniffi/iroh_location"
  mkdir -p "$out"
  printf 'generated kotlin\n' > "$out/iroh_location.kt"
else
  out="$root/modules/iroh-location/ios/generated"
  mkdir -p "$out"
  printf 'generated swift\n' > "$out/iroh_location.swift"
  printf 'generated header\n' > "$out/iroh_locationFFI.h"
  printf 'generated modulemap\n' > "$out/iroh_locationFFI.modulemap"
fi
EOF
  chmod 700 "$root/scripts/generate-uniffi-bindings.sh"
}

# Run the hook out of a given tree, with the fake toolchain and a HOME of its own so nothing
# touches the developer's real caches.
run_hook() {
  local root="$1" platform="$2" abis="${3:-}"
  : > "$build_log"
  env -i \
    PATH="$test_root/bin:/usr/bin:/bin" \
    HOME="$test_root/home" \
    TMPDIR="${TMPDIR:-/tmp}" \
    FAKE_BUILD_LOG="$build_log" \
    FAKE_RUSTC_VERSION="${FAKE_RUSTC_VERSION:-1.90.0}" \
    EAS_BUILD_PLATFORM="$platform" \
    SC_NATIVE_CACHE_DIR="$test_root/cache" \
    SC_BUILD_PROFILE_DIR="$test_root/profile" \
    ${abis:+SC_ANDROID_ABIS="$abis"} \
    bash "$root/scripts/eas-build-pre-install.sh"
}

built() { [[ -s "$build_log" ]]; }

make_tree "$test_root/a"

# --- 1. A cold run builds every requested ABI and stages it ------------------

run_hook "$test_root/a" android 'arm64-v8a armeabi-v7a x86_64'
built || fail "the first Android run reused something from an empty cache"

for abi in arm64-v8a armeabi-v7a x86_64; do
  [[ -f "$test_root/a/modules/iroh-location/android/src/main/jniLibs/$abi/libiroh_location.so" ]] ||
    fail "the first Android run did not produce $abi"
done
grep -q 'bindgen android' "$build_log" || fail "the first Android run skipped binding generation"

# --- 2. A different checkout of the same sources hits, and a subset hits -----

# The tree is COPIED to a new absolute path, which is what the warm job and a real build actually
# differ by. Nothing else changes.
cp -R "$test_root/a" "$test_root/b"
rm -rf "$test_root/b/modules/iroh-location/android/src/main/jniLibs"
rm -rf "$test_root/b/modules/iroh-location/android/src/main/java/uniffi"

run_hook "$test_root/b" android 'arm64-v8a'
if built; then
  fail "a build ran despite identical sources — the digest is not path-independent"
fi
[[ -f "$test_root/b/modules/iroh-location/android/src/main/jniLibs/arm64-v8a/libiroh_location.so" ]] ||
  fail "the cache hit did not restore the requested ABI"
[[ -f "$test_root/b/modules/iroh-location/android/src/main/java/uniffi/iroh_location/iroh_location.kt" ]] ||
  fail "the cache hit did not restore the UniFFI bindings"

# Bindings and library must travel together: UniFFI aborts at load time when their API checksums
# disagree, so restoring one without the other trades build time for a crash on device.
grep -q 'generated kotlin' \
  "$test_root/b/modules/iroh-location/android/src/main/java/uniffi/iroh_location/iroh_location.kt" ||
  fail "the restored bindings are not the ones staged with the library"

# --- 3. Asking for an ABI that was never staged must miss --------------------

rm -rf "$test_root/cache/android/"*/x86_64
run_hook "$test_root/b" android 'arm64-v8a x86_64'
built || fail "a missing ABI was served from cache"

# --- 4. Every digest input forces a rebuild ----------------------------------

assert_rebuild_after() {
  local label="$1"
  shift
  "$@"
  run_hook "$test_root/b" android 'arm64-v8a'
  built || fail "changing $label did not invalidate the native cache"
  # ...and the rebuilt state is itself cacheable, so the next run is a hit again.
  run_hook "$test_root/b" android 'arm64-v8a'
  if built; then
    fail "the cache did not re-stage after a rebuild triggered by $label"
  fi
}

run_hook "$test_root/b" android 'arm64-v8a' # settle on a hit before each mutation
assert_rebuild_after 'a crate source' \
  bash -c "printf 'pub fn changed() {}\n' >> '$test_root/b/modules/iroh-location/rust/src/lib.rs'"
assert_rebuild_after 'the lockfile' \
  bash -c "printf '# bumped\n' >> '$test_root/b/modules/iroh-location/rust/Cargo.lock'"
assert_rebuild_after 'a vendored dependency' \
  bash -c "printf 'pub fn v2() {}\n' >> '$test_root/b/modules/iroh-location/rust/third_party/vendored/lib.rs'"
assert_rebuild_after 'the build script' \
  bash -c "printf '# comment\n' >> '$test_root/b/scripts/eas-build-pre-install.sh'"

# The Rust toolchain is the input GitHub's hashFiles cannot see, which is exactly why the hook
# computes a digest of its own instead of trusting the cache key.
FAKE_RUSTC_VERSION=1.91.0
export FAKE_RUSTC_VERSION
run_hook "$test_root/b" android 'arm64-v8a'
built || fail "a new Rust toolchain did not invalidate the native cache"
unset FAKE_RUSTC_VERSION

# --- 5. iOS follows the same rules ------------------------------------------

run_hook "$test_root/a" ios
built || fail "the first iOS run reused something from an empty cache"
[[ -f "$test_root/a/modules/iroh-location/ios/IrohLocationFFI.xcframework/Info.plist" ]] ||
  fail "the first iOS run did not produce an XCFramework"
[[ -f "$test_root/a/modules/iroh-location/ios/headers/module.modulemap" ]] ||
  fail "the first iOS run did not produce the module map"

rm -rf \
  "$test_root/b/modules/iroh-location/ios/IrohLocationFFI.xcframework" \
  "$test_root/b/modules/iroh-location/ios/headers" \
  "$test_root/b/modules/iroh-location/ios/generated"

# tree b has drifted from tree a by now, so restore it before expecting a hit.
rm -rf "$test_root/b/modules/iroh-location/rust" "$test_root/b/scripts"
cp -R "$test_root/a/modules/iroh-location/rust" "$test_root/b/modules/iroh-location/rust"
cp -R "$test_root/a/scripts" "$test_root/b/scripts"

run_hook "$test_root/b" ios
if built; then
  fail "the iOS cache missed on an identical checkout at a different path"
fi
[[ -f "$test_root/b/modules/iroh-location/ios/IrohLocationFFI.xcframework/Info.plist" ]] ||
  fail "the iOS cache hit did not restore the XCFramework"
[[ -f "$test_root/b/modules/iroh-location/ios/headers/module.modulemap" ]] ||
  fail "the iOS cache hit did not restore the headers"
[[ -f "$test_root/b/modules/iroh-location/ios/generated/iroh_location.swift" ]] ||
  fail "the iOS cache hit did not restore the Swift bindings"

echo "The native artifact cache reused artifacts across checkouts and ABI subsets, and rebuilt for every change to the sources, the lockfile, the build script, and the toolchain."
