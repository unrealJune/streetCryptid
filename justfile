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

# Build a RELEASE app for the e2e harness and install it on every booted iOS Simulator.
#
# Use this, not `run-ios`, before an e2e run. A debug/dev-client build cannot be driven reliably:
# expo-dev-menu opens on a shake or three-finger touch — both of which a simulator driven by
# synthetic gestures trips — and renders OVER the app, so selectors underneath silently stop
# resolving mid-flow. Its preferences cannot be pinned off either; the app rewrites that plist on
# exit. A Release build has no dev menu, no dev-launcher server picker, and embeds the JS bundle,
# so it does not need Metro. The DEBUG section of Settings the harness reads the invite token
# from is not `__DEV__`-gated and is still present.
#
# Needs `pod` on PATH (Homebrew's is at /opt/homebrew/bin).
e2e-build-ios device="":
    #!/usr/bin/env bash
    set -euo pipefail
    export PATH="/opt/homebrew/bin:$PATH"
    target="{{device}}"
    if [ -z "$target" ]; then
      target="$(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(next(x["udid"] for v in d.values() for x in v if "iPhone" in x["name"]))')"
    fi
    bunx expo run:ios --configuration Release --device "$target"
    app="$(ls -d ~/Library/Developer/Xcode/DerivedData/streetCryptid-*/Build/Products/Release-iphonesimulator/streetCryptid.app | head -1)"
    # Same binary onto every other booted simulator — no rebuild, and it guarantees the pool is
    # running identical code.
    for udid in $(xcrun simctl list devices booted -j | python3 -c 'import json,sys; d=json.load(sys.stdin)["devices"]; print(" ".join(x["udid"] for v in d.values() for x in v if "iPhone" in x["name"]))'); do
      [ "$udid" = "$target" ] && continue
      xcrun simctl terminate "$udid" com.unrealjune.streetcryptid >/dev/null 2>&1 || true
      xcrun simctl uninstall "$udid" com.unrealjune.streetcryptid >/dev/null 2>&1 || true
      xcrun simctl install "$udid" "$app"
      echo "installed on $udid"
    done

# Two-device Maestro E2E: onboards both devices if needed, pairs them over an
# invite link, and asserts both sides mint a friend record. Each device is
# ios:<udid>, android:<serial>, or a bare udid (== ios:) — including a mixed
# iOS<->Android pair. Needs `maestro` on PATH and both devices running the app.
# Example: `just e2e-pairing 5834FA5F-... android:emulator-5554`
e2e-pairing device-a device-b:
    bash scripts/e2e/pairing-e2e.sh {{device-a}} {{device-b}}

# One-device background pipeline smoke test, iOS or Android. `device` is ios:<udid>,
# android:<serial>, or a bare udid (== ios:). The device needs a current local build.
# Examples: `just e2e-background 354E950C-...` / `just e2e-background android:emulator-5554`
e2e-background device:
    bash scripts/e2e/background-location-e2e.sh {{device}}

# Create/reuse the stash-only host observer (works against either platform).
e2e-observer device:
    bash scripts/e2e/ensure-stash-observer.sh {{device}}

# Three-party test: pair device-a <-> device-b, plus a CLI observer against each, then verify
# every edge (both pipelines + both friend-side decryptions). Each device is ios:<udid>,
# android:<serial>, or a bare udid. A mixed iOS<->Android pair is supported.
# Example: `just e2e-trio 354E950C-... android:emulator-5554`
e2e-trio device-a device-b:
    bash scripts/e2e/trio-e2e.sh {{device-a}} {{device-b}}

# Compare battery, balanced, and fidelity profiles on identical simulator routes.
# Defaults to six minutes each for walking + driving (~36 minutes total).
benchmark-ios-location device output="ios-location-benchmark.tsv":
    bash scripts/e2e/ios-location-benchmark.sh {{device}} {{output}}

# Run the declarative scenario matrix (scripts/e2e/scenarios/*.yaml) across a pool of simulators.
# `devices` is "auto" (default — boots/reuses enough simulators automatically) or a comma-separated
# UDID list. See scripts/e2e/run-matrix.sh --help and scripts/e2e/PHYSICAL-DEVICE-CHECKLIST.md for
# what it can't cover. Extra args pass straight through to run-matrix.sh.
# Examples:
#   just e2e-matrix
#   just e2e-matrix auto --only background-walking,cold-pairing-sync
#   just e2e-matrix 5834FA5F-...,37D03B5C-...,354E950C-...
# NOTE the single variadic parameter: `just` (1.18) rejects "non-default parameter follows
# default parameter", so `devices="auto" *args` will not parse. Taking everything as `*args` and
# defaulting the first one in the body keeps all three call shapes working.
e2e-matrix *args:
    #!/usr/bin/env sh
    set -eu
    set -- {{args}}
    devices="${1:-auto}"
    [ $# -gt 0 ] && shift
    bash scripts/e2e/run-matrix.sh --devices "$devices" "$@"

# List every scenario the matrix runner knows about without running anything.
e2e-matrix-list:
    bash scripts/e2e/run-matrix.sh --list

# Long-running soak: repeatedly drives one or more single-device scenarios for `hours`, sampling
# event_log every `sample-minutes` instead of asserting once at the end. Meant to be left running.
# Example: `just e2e-soak auto background-walking 6`
e2e-soak devices="auto" scenarios="background-walking" hours="2":
    bash scripts/e2e/soak.sh --devices {{devices}} --scenarios {{scenarios}} --hours {{hours}}

# Start/reuse (default), check, or stop the local trail-stash used by network-chaos scenarios
# (scripts/e2e/scenarios/chaos-*.yaml — see run-matrix.sh's `require_local_stash` handling and
# lib/netchaos.sh). Needs a local github.com/unrealJune/trail-stash checkout (default: ~/trail-stash,
# override with TRAIL_STASH_REPO). Prints the .env.local lines + rebuild reminder needed to point
# a dev-client build at it — run-matrix.sh does NOT rebuild the app for you.
# Example: `just e2e-local-stash` / `just e2e-local-stash status` / `just e2e-local-stash stop`
e2e-local-stash cmd="start":
    bash scripts/e2e/ensure-local-stash.sh {{cmd}}

# Profile the deterministic launch/zoom/pan region-build sequence (fixture by default).
profile-map source="":
    bun scripts/profile-scene.ts {{source}}

# Headless map screenshots — runs the real dot-field pipeline through CanvasKit
# on the host, no simulator. Needs EXPO_PUBLIC_TILE_URL (just env-pull development).
# Highways are off by default so water reads clearly; --legacy-rivers renders the
# pre-taper river width for a before/after pair.
#   just map-shot
#   just map-shot "--out /tmp/shots --places europe,india --zooms 4,7,10,13"
map-shot *args:
    bun scripts/map-shot.ts {{args}}

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

# --- Native module: cryptid-generator (Kotlin + Swift) -----------------------

# Test the on-device icon generator's Kotlin output parser (JVM unit tests).
# Not part of `check-all`: needs the Android SDK and a generated android/ (run `just prebuild`).
test-android:
    cd android && ./gradlew :cryptid-generator:testDebugUnitTest

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

# Send an already-built store archive to the store, over the same EAS-free path CI uses.
# Example: `just submit ios ./streetcryptid.ipa` / `just submit android ./streetcryptid.aab`.
# iOS needs ASC_API_KEY_ID, ASC_API_ISSUER_ID and ASC_API_KEY_P8_BASE64 in the environment;
# Android needs PLAY_SERVICE_ACCOUNT_JSON_BASE64. (The same values CI holds in `production-release`.)
submit platform="android" artifact="":
    #!/usr/bin/env sh
    set -eu
    if [ -z "{{artifact}}" ]; then
      echo "Usage: just submit <ios|android> <path to the .ipa/.aab>" >&2
      exit 2
    fi
    case "{{platform}}" in
      ios) bash scripts/submit-testflight.sh "{{artifact}}" ;;
      android) bash scripts/submit-play.sh "{{artifact}}" ;;
      *) echo "Expected platform ios or android." >&2; exit 2 ;;
    esac

# Build a production binary on EAS and auto-submit it (iOS→TestFlight, Android→Play internal).
# Example: `just release android` or `just release ios`.
# CI does this for you on every push to main (see README "Automatic releases"); reach for this only
# when you need an out-of-band build.
# NOTE: this is the EAS *cloud* path -- it spends build quota and relies on EAS Submit, which the
# release pipeline no longer uses. For a local build plus a direct store upload, run
# `just build-prod <platform>` (or `eas build --local`) and then `just submit <platform> <artifact>`.
release platform="android":
    bunx eas-cli build --platform {{platform}} --profile production --auto-submit

# Remote-build BOTH iOS and Android and auto-submit each to its internal track
# (iOS→TestFlight, Android→Google Play internal). One command, one release.
# Same EAS cloud caveat as `release` above.
release-all:
    bunx eas-cli build --platform all --profile production --auto-submit

# Publish an over-the-air update. Example: `just update "fix crash"`.
update message="update":
    bunx eas-cli update --auto --message "{{message}}"

# --- Release automation ------------------------------------------------------

# Print the version the next push to main would release, and why.
# Needs the full history and tags: `git fetch --tags --unshallow` on a shallow clone.
next-version:
    bash scripts/next-version.sh

# Write a version into app.json + package.json (what the release workflow commits).
set-version version:
    bash scripts/apply-version.sh {{version}}

# Run the release pipeline's CI guards: EAS output isolation and version resolution.
test-release:
    bash scripts/test-eas-ci-log-isolation.sh
    bash scripts/test-next-version.sh

# --- Housekeeping ------------------------------------------------------------

# Remove caches and build outputs (keeps node_modules).
clean:
    rm -rf .expo dist web-build node_modules/.cache

# Remove native caches: the generated ios/ and android/ projects, the
# iroh-location cargo target dir, and this project's Xcode DerivedData.
clean-native: clean
    rm -rf ios android
    rm -rf modules/iroh-location/rust/target
    rm -rf ~/Library/Developer/Xcode/DerivedData/streetCryptid-*

# Print key tool versions.
versions:
    @bun --version && bunx expo --version

# --- High-Specificity Recipes ------------------------------------------------------------

# Build the iOS dev client locally through EAS and install it on a cable-connected iPhone.
# Requires macOS + Xcode.
#
# Use this rather than `expo run:ios` when you do not personally hold the team's iOS
# signing credentials: eas.json sets `credentialsSource: remote`, so EAS supplies the
# ad hoc provisioning profile.
#
# `eas build --local` has no build cache of its own and copies the project to a temp
# workdir, so Pods and Xcode start cold each run. CARGO_TARGET_DIR is pinned back to
# the repo's own target dir (the path CI also pins) so the release build of iroh in
# scripts/eas-build-pre-install.sh stays incremental instead of recompiling the whole
# iroh/gossip/docs tree every time.
#
# To wipe this target dir use just clean-native.
#
# Before you run this, you might want to try just env-pull development;
# This will set env vars to match expo's cloud builds.
# If you were previously missing these, you need to force-quit the app on iOS and just start again.
#
# After you run this, next step is just start, start-clear, or start-with-tailscale,
# depending what you need. 
#
# Installs on the first connected device unless you name one; `xcrun devicectl list
# devices` prints the identifiers. Launches the app afterwards — start Metro first
# (`just start` / `just start-with-tailscale`) or the dev client opens to its launcher.
#   just ios-dev-install
#   just ios-dev-install EC8C13BD-FD59-4041-92F6-F32EE2E5180E
ios-dev-install device="":
    #!/usr/bin/env sh
    set -eu
    root="$(pwd)"
    ipa="$root/streetcryptid-development.ipa"
    dev="{{device}}"
    if [ -z "$dev" ]; then
      json="$(mktemp)"
      xcrun devicectl list devices --json-output "$json" >/dev/null
      dev="$(node -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const d=(r.result.devices||[]).find(x=>x.connectionProperties&&x.connectionProperties.tunnelState==="connected");process.stdout.write(d?d.identifier:"")' "$json")"
      rm -f "$json"
      if [ -z "$dev" ]; then
        echo "No connected iPhone found. Plug one in, or pass an identifier from 'xcrun devicectl list devices'." >&2
        exit 1
      fi
    fi
    echo "Installing to device $dev"
    export CARGO_TARGET_DIR="$root/modules/iroh-location/rust/target"
    export EXPO_NO_TELEMETRY=1
    bunx eas-cli build \
      --local \
      --platform ios \
      --profile development \
      --output "$ipa" \
      --non-interactive \
      --freeze-credentials
    xcrun devicectl device install app --device "$dev" "$ipa"
    xcrun devicectl device process launch --device "$dev" com.unrealjune.streetcryptid

# Prove a device that was AWAY recovers what it missed (goal 4): the sender moves while the
# receiver is backgrounded (MODE=background) or force-quit (MODE=terminate), then the receiver
# returns and must hold a fix it demonstrably did not have. Each device is ios:<udid>,
# android:<serial>, or a bare udid.
# Example: `just e2e-reconcile 354E950C-... android:emulator-5554`
e2e-reconcile sender receiver:
    bash scripts/e2e/reconcile-e2e.sh {{sender}} {{receiver}}

# Prove a friend can hand on an author's fix after the author goes dark (goal 5). Three devices in
# one sharing pool: the author publishes and is force-quit, the relay stays online, and the late
# device — with the stash switched OFF, so the durable server cannot answer — must still obtain
# the author's fix. See scripts/e2e/relay-e2e.sh for why each source is excluded.
# Example: `just e2e-relay 354E950C-... android:emulator-5554 C9171FC5-...`
e2e-relay author relay late:
    bash scripts/e2e/relay-e2e.sh {{author}} {{relay}} {{late}}
