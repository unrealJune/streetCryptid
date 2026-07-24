# streetCryptid — common developer tasks.
# Run `just` (or `just --list`) to see every recipe.
# Package manager: bun. Recipes are POSIX-sh friendly (works on Windows via Git sh, macOS, and Linux).

# Show the list of available recipes.
default:
    @just --list

# --- Setup -------------------------------------------------------------------

# Install dependencies from the lockfile.
install:
    bun install

# Nuke node_modules and reinstall from scratch.
reset:
    rm -rf node_modules && bun install

# --- Dev servers -------------------------------------------------------------

# Start the Metro dev server (then press a=Android, i=iOS, w=web).
start:
    bun run start

# Start the dev server with the Metro cache cleared.
start-clear:
    bunx expo start --clear

# Advertises this machine's Tailscale MagicDNS name so a `development`-profile
# dev-client build reaches Metro over the tailnet. Shows a Tailscale QR code.
# Serve Metro over Tailscale for a dev-client build (needs Tailscale + MagicDNS).
#
# Pass any second argument to clear Metro's transform cache on the way up — needed
# after adding a NEW source file (an already-running bundler can miss it, and the
# import lands as undefined at runtime) or after changing .env.local, since
# EXPO_PUBLIC_* values are inlined at bundle time.
#   just start-with-tailscale
#   just start-with-tailscale 8081 clear
start-with-tailscale port="8081" clear="":
    #!/usr/bin/env sh
    set -eu
    ts=tailscale
    command -v tailscale >/dev/null 2>&1 || ts="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    name="$("$ts" status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).Self?.DNSName||"").replace(/\.$/,""))}catch{}})')"
    if [ -z "$name" ]; then
      echo "No Tailscale MagicDNS name found — is Tailscale up with MagicDNS enabled? (use 'just start' for LAN)" >&2
      exit 1
    fi
    echo "Metro over Tailscale -> http://$name:{{port}}"
    if [ -n "{{clear}}" ]; then
      EXPO_PACKAGER_PROXY_URL="http://$name:{{port}}" bunx expo start --clear
    else
      EXPO_PACKAGER_PROXY_URL="http://$name:{{port}}" bun run start
    fi

# Open the app on a connected Android device / emulator.
android:
    bun run android

# Open the app on an iOS simulator (macOS only).
ios:
    bun run ios

# Open the app in a web browser.
web:
    bun run web

# --- Native / prebuild -------------------------------------------------------

# Compile & install a native Android debug build (needs Android SDK + JDK).
run-android:
    bunx expo run:android

# Compile & install a native iOS debug build (macOS only).
run-ios:
    bunx expo run:ios

# Generate the native android/ and ios/ projects (managed prebuild).
prebuild:
    bun run prebuild

# Clean-regenerate the native projects.
prebuild-clean:
    bunx expo prebuild --clean

# --- Quality -----------------------------------------------------------------

# Type-check with tsc. Run `just start` once first so Expo generates its types.
typecheck:
    bun run typecheck

# Lint with ESLint (eslint-config-expo).
lint:
    bun run lint

# Lint and auto-fix what can be fixed.
lint-fix:
    bun run lint:fix

# Format every file with Prettier.
format:
    bun run format

# Verify formatting without writing changes.
format-check:
    bun run format:check

# Run the jest test suite.
test:
    bun run test

# Profile the deterministic launch/zoom/pan region-build sequence (fixture by default).
profile-map source="":
    bun scripts/profile-scene.ts {{source}}

# Run the full local gate: types, lint, formatting, and tests (JS/TS only).
check: typecheck lint format-check test

# Full gate including the native iroh-location Rust crate and generated bindings.
check-all: check test-rust check-bindings

# Expo project health check.
doctor:
    bunx expo-doctor

# Verify installed deps match the current Expo SDK.
deps-check:
    bunx expo install --check

# Upgrade deps to match the current Expo SDK.
deps-fix:
    bunx expo install --fix

# --- Native module: iroh-location (Rust + WASM) ------------------------------

# Test the Rust crate: crypto envelope + durable-trail (iroh-docs) logic. Portable; runs anywhere.
test-rust:
    cd modules/iroh-location/rust && cargo test

# Benchmark Rust protobuf parsing + SCG1 encoding with committed fixtures.
profile-mvt:
    cd modules/iroh-location/rust && cargo run --release --example profile_mvt -- 200 20

# Compile the Rust crate against the pinned iroh/gossip/docs deps (no bindings generated).
build-rust:
    cd modules/iroh-location/rust && cargo build

# Pair/watch a phone through the trail stash with the host-side Rust debug client.
# Examples:
#   just trail-stash-client status
#   just trail-stash-client pair --adb
#   just trail-stash-client watch --once --json
trail-stash-client *args:
    cargo run --manifest-path modules/iroh-location/rust/Cargo.toml --features cli --bin trail-stash-client -- {{args}}

# Verify tracked Swift/C and Kotlin UniFFI bindings match the Rust API.
check-bindings:
    bash scripts/check-uniffi-bindings.sh

# Needs wasm-pack + the wasm32-unknown-unknown target; web/ is a git-ignored build output (README §5).
# Build the browser WASM bundle (relay-only iroh + in-memory docs) into modules/iroh-location/web/.
build-wasm:
    cd modules/iroh-location/rust-wasm && wasm-pack build --target web --release --out-dir ../web

# Needs the Android NDK + cargo-ndk. Run after changing the Rust UniFFI surface (see README §3).
# Regenerate Android jniLibs + Kotlin UniFFI bindings.
bindgen-android:
    #!/usr/bin/env sh
    set -eu
    bash scripts/generate-uniffi-bindings.sh android
    cd modules/iroh-location/rust
    # Cross-compile the .so for every Android ABI into jniLibs.
    cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -o ../android/src/main/jniLibs build --release

# Rebuild ONLY the arm64 iroh-location .so into jniLibs — the fast path before a
# local on-device release build (most phones are arm64). Full 3-ABI + binding
# regen is `bindgen-android`. cargo-ndk auto-detects the NDK under $ANDROID_HOME.
bindgen-android-arm64:
    cd modules/iroh-location/rust && cargo ndk -t arm64-v8a -o ../android/src/main/jniLibs build --release

# Build a STANDALONE release APK locally (Hermes bundle embedded, no Metro at
# runtime) and install + launch it on a USB-connected arm64 device. Use to verify
# release-only behavior — production Hermes bytecode, minification, patched deps
# (e.g. the pbf MVT/Hermes patch) — without an EAS cloud build.
#
# PREFER `eas build --local -p android --profile production-internal-android`
# when you can: it runs the real CI pipeline (eas-build-pre-install.sh regenerates
# UniFFI bindings AND cargo-ndk-builds every-ABI .so, so the stale-.so startup abort
# below is impossible), embeds the Hermes bundle, and signs with the EAS *remote*
# key, so `adb install -r` needs no uninstall. It is NOT supported on native Windows
# — run it from WSL2/macOS/Linux. Configure required EXPO_PUBLIC_* values in the EAS
# production environment. This recipe is the native-Windows fast path when
# WSL2/cloud isn't handy.
#
# Rebuilds the arm64 iroh-location .so FIRST so the packaged native library matches
# the committed UniFFI bindings. A stale jniLibs .so aborts at startup with
# `undefined symbol: uniffi_iroh_location_checksum_method_...` (the Kotlin bindings
# assert each method's checksum at load). For all ABIs run `just bindgen-android`.
#
# Local builds sign with credentials/streetcryptid.keystore — a DIFFERENT key from
# the EAS *remote* keystore (eas.json credentialsSource: remote) and a lower
# versionCode — so an installed EAS build blocks the update on signature/downgrade.
# This recipe therefore UNINSTALLS first, wiping on-device app data (tile SQLite
# cache, trails, pairing). Uses the ambient JAVA_HOME: point it at JDK 17/21 (e.g.
# Android Studio's bundled JBR); the Expo/AGP gradle plugins reject JDK 25+.
run-android-release: bindgen-android-arm64
    #!/usr/bin/env sh
    set -eu
    cd android && ./gradlew assembleRelease && cd ..
    apk="android/app/build/outputs/apk/release/app-release.apk"
    adb uninstall com.unrealjune.streetcryptid || true
    adb install "$apk"
    adb shell am start -n com.unrealjune.streetcryptid/.MainActivity

# Regenerate the iOS XCFramework + Swift UniFFI bindings. macOS + full Xcode only (see README §2).
bindgen-ios:
    #!/usr/bin/env sh
    set -eu
    export IPHONEOS_DEPLOYMENT_TARGET=16.4
    rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
    bash scripts/generate-uniffi-bindings.sh ios
    cd modules/iroh-location/rust
    cargo build --locked --release --target aarch64-apple-ios
    cargo build --locked --release --target aarch64-apple-ios-sim
    cargo build --locked --release --target x86_64-apple-ios
    mkdir -p ../ios/headers
    cp ../ios/generated/iroh_locationFFI.h ../ios/headers/
    cp ../ios/generated/iroh_locationFFI.modulemap ../ios/headers/module.modulemap
    rm -rf ../ios/IrohLocationFFI.xcframework
    mkdir -p target/ios-simulator/release
    lipo -create \
      target/aarch64-apple-ios-sim/release/libiroh_location.a \
      target/x86_64-apple-ios/release/libiroh_location.a \
      -output target/ios-simulator/release/libiroh_location.a
    xcodebuild -create-xcframework \
      -library target/aarch64-apple-ios/release/libiroh_location.a -headers ../ios/headers \
      -library target/ios-simulator/release/libiroh_location.a -headers ../ios/headers \
      -output ../ios/IrohLocationFFI.xcframework

# --- EAS: cloud build / submit / update --------------------------------------

# Log in to your Expo (EAS) account.
eas-login:
    bunx eas-cli login

# Link this project to an EAS project (writes the projectId).
eas-init:
    bunx eas-cli init

# Pull an EAS environment into the ignored .env.local file used by Expo CLI and Metro.
env-pull environment="development":
    bunx eas-cli env:pull --environment "{{environment}}" --path .env.local --non-interactive

# Build via EAS. Examples: `just build`, `just build ios`, `just build android production`.
build platform="android" profile="preview":
    bunx eas-cli build --platform {{platform}} --profile {{profile}}

# Build an installable development client.
build-dev platform="android":
    bunx eas-cli build --platform {{platform}} --profile development

# Production build.
build-prod platform="android":
    bunx eas-cli build --platform {{platform}} --profile production

# Submit the latest build to the store. Example: `just submit ios`.
submit platform="android":
    bunx eas-cli submit --platform {{platform}}

# Build a production binary and auto-submit it (iOS→TestFlight, Android→Play internal track).
# Example: `just release android` or `just release ios`.
release platform="android":
    bunx eas-cli build --platform {{platform}} --profile production --auto-submit

# Remote-build BOTH iOS and Android and auto-submit each to its internal track
# (iOS→TestFlight, Android→Google Play internal). One command, one release.
release-all:
    bunx eas-cli build --platform all --profile production --auto-submit

# Publish an over-the-air update. Example: `just update "fix crash"`.
update message="update":
    bunx eas-cli update --auto --message "{{message}}"

# --- Housekeeping ------------------------------------------------------------

# Remove caches and build outputs (keeps node_modules).
clean:
    rm -rf .expo dist web-build node_modules/.cache

# Print key tool versions.
versions:
    @bun --version && bunx expo --version
