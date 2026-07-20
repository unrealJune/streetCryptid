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

# Compile the Rust crate against the pinned iroh/gossip/docs deps (no bindings generated).
build-rust:
    cd modules/iroh-location/rust && cargo build

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
