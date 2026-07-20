# iroh-location (local Expo module)

streetCryptid's decentralized, end-to-end-encrypted friend location core. Wraps
**iroh 1.0** (QUIC transport) + **iroh-gossip 0.101** (live broadcast) and per-recipient
crypto (Rust `rust/`), exposed to React Native via **UniFFI → Expo Modules API**.

> Design of record: [`docs/social/ARCHITECTURE.md`](../../docs/social/ARCHITECTURE.md).

## Why this module exists

`iroh-ffi` 1.0 (the official Swift/Kotlin bindings) exposes **only iroh core** —
`iroh-gossip`/`iroh-docs`/`iroh-blobs` are out of scope. So we ship our own Rust crate
and UniFFI bindings.

## Layout

```
rust/                 cargo crate `iroh-location` (crypto is unit-tested; iroh glue in lib.rs)
  src/crypto.rs       envelope: RFC 8439 ChaCha20-Poly1305 + HPKE wrap + ed25519 sign
  src/lib.rs          UniFFI domain API (LocationNode, Subscription, FixListener)
  src/bin/uniffi-bindgen.rs
ios/                  IrohLocationModule.swift + IrohLocation.podspec (+ generated/ + xcframework)
android/              build.gradle + IrohLocationModule.kt (+ src/main/jniLibs/ + generated Kotlin)
src/                  TS API (types + native/web accessors)
rust-wasm/            browser WASM crate (iroh relay-only + shared crypto)
web/                  wasm-pack output imported by `IrohLocationModule.web.ts`
index.ts             public JS entry (imported as `iroh-location`)
```

The app talks to this module through `getIrohLocation()` / `tryGetIrohLocation()`;
native resolves `requireNativeModule('IrohLocation')`, while web resolves
`IrohLocationModule.web.ts`. The TS type contract lives in `src/IrohLocation.types.ts`
and is mirrored by the app's service.

## What runs where

- `cargo test` (in `rust/`) verifies the crypto envelope plus the pairing protocol: nonce
  commit/reveal, transcript-derived visual SAS, session-peer binding, mutual confirmation,
  mismatch/timeout handling, and simultaneous nearby initiation. **This is fully portable and the
  security core is validated here.**
- Everything below (cross-compile, dev client, on-device A→B) requires **macOS/Xcode**
  (iOS), **Android NDK**, and **physical devices**.

## Build pipeline

The generated Android `.so` files and iOS XCFramework are git-ignored. EAS runs
`scripts/eas-build-pre-install.sh` to rebuild the correct platform artifact from the committed Rust
source before each cloud build.

### 0. Toolchain

```bash
# Rust + mobile targets
rustup target add aarch64-apple-ios aarch64-apple-ios-sim \
  aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
cargo install cargo-ndk cargo-make
# Android NDK installed; ANDROID_NDK_HOME set. Kotlin 2.2+.
```

### 1. Verify the crate

```bash
cd modules/iroh-location/rust
cargo test           # crypto envelope tests (should pass everywhere)
cargo build          # compiles iroh + gossip glue against the pinned versions
```

### 2. iOS — XCFramework + Swift bindings

> **Prerequisite: full Xcode** (not just Command Line Tools) — the iOS SDKs
> (`iphoneos`/`iphonesimulator`) are required. Verify with
> `xcrun --sdk iphoneos --show-sdk-path`; if it errors, run
> `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` and
> `sudo xcodebuild -license accept`.

The validated manual pipeline (no `cargo make` needed). Build one iOS static-lib slice
per arch, generate the Swift bindings from any built lib, then assemble an XCFramework:

```bash
cd modules/iroh-location/rust
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

# Swift bindings (uses an unstripped host build because release stripping can remove UniFFI
# metadata on ELF hosts; needs the `cli` feature):
cargo build --features cli
cargo run --bin uniffi-bindgen --features cli -- generate \
  --library target/debug/libiroh_location.dylib --crate iroh_location \
  --language swift --out-dir ../ios/generated
# -> ../ios/generated/{iroh_location.swift, iroh_locationFFI.h, iroh_locationFFI.modulemap}

# Static libs (device = aarch64-apple-ios; simulator = aarch64-apple-ios-sim on Apple
# Silicon, or x86_64-apple-ios on an Intel Mac):
cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim   # or x86_64-apple-ios (Intel)

# Assemble the XCFramework the podspec expects, wiring the modulemap as headers:
mkdir -p ../ios/headers && cp ../ios/generated/iroh_locationFFI.h ../ios/headers/
cp ../ios/generated/iroh_locationFFI.modulemap ../ios/headers/module.modulemap
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libiroh_location.a -headers ../ios/headers \
  -library target/aarch64-apple-ios-sim/release/libiroh_location.a -headers ../ios/headers \
  -output ../ios/IrohLocationFFI.xcframework
```

For EAS iOS builds, `eas-build-pre-install` runs
`scripts/eas-build-pre-install.sh` before prebuild and CocoaPods. The hook installs the
Rust toolchain when needed, regenerates the Swift/FFI bindings from the current Rust API,
builds the App Store device slice with the iOS 16.4 deployment target used by Expo SDK 57,
and creates the git-ignored XCFramework. Regenerating is required because UniFFI aborts on
first use when a generated API checksum does not match the linked archive. The podspec
propagates the Rust archive's `Network`, `CoreBluetooth`, and `SystemConfiguration`
dependencies to the app linker. Local device and simulator builds still use
`just bindgen-ios`.

> **Temporary iOS App Store limitation (2026-07-12):** the
> `com.apple.developer.networking.multicast` entitlement is intentionally omitted from
> `app.json` while Apple reviews the managed-capability request for
> `com.unrealjune.streetcryptid`. iOS remains functional through authenticated relay/DNS
> discovery and BLE, but the direct same-Wi-Fi mDNS fast path may be unavailable. After
> Apple approves the capability, restore the entitlement under `expo.ios.entitlements`,
> regenerate the App Store provisioning profile with
> `eas credentials:configure-build --platform ios --profile production`, and rebuild.

### 3. Android — jniLibs + Kotlin bindings

```bash
cd modules/iroh-location/rust
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 \
  -o ../android/src/main/jniLibs build --release
cargo build --features cli
cargo run --bin uniffi-bindgen --features cli -- generate \
  --library target/debug/libiroh_location.so --crate iroh_location \
  --language kotlin --out-dir ../android/src/main/java
```

`build.gradle` pins the JNA **`@aar`** variant (bundles `libjnidispatch.so`) — the plain
jar crashes on device. Requires Kotlin 2.2+.

`IrohAndroidBootstrap.install(...)` runs during module `OnCreate`: it loads the
shared library, installs a process-lifetime application context for iroh's DNS
resolver, and initializes the BLE managers before any endpoint is constructed.

The BLE transport also needs the vendored `blew` Android runtime under
`android/src/main/java/org/jakebot/blew/`. The Expo module loads
`libiroh_location.so` during `OnCreate`, which runs the Rust `JNI_OnLoad`
bootstrap, then initializes `BleCentralManager` and `BlePeripheralManager` with
the application context. Its manifest contributes the modern
scan/connect/advertise permissions and pre-Android-12 fallbacks.

On iOS, the pod links both `Network.framework` (iroh QUIC) and
`CoreBluetooth.framework` (the BLE custom transport). `app.json` provides the
Bluetooth usage description.

### 4. Dev client + run

```bash
# from the repo root
bunx expo prebuild --clean          # autolinks this local module
just run-android                    # or: bunx expo run:ios (on macOS)
```

Expo Go is **not** supported because it cannot load this local native module.

### 5. Web (WASM, relay-only)

The web path builds a sibling Rust crate so the native UniFFI crate stays untouched:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
just build-wasm
```

`src/IrohLocationModule.web.ts` registers a web Expo module with the same
`IrohLocationApi` and event surface as native. It imports `web/iroh_location_wasm.js`
and requires `web/iroh_location_wasm_bg.wasm` as a Metro asset; `metro.config.js` adds
`wasm` to `assetExts` so `bunx expo export -p web` copies the binary.

Configure the authenticated relay endpoints and limited-scope client credential in the
ignored root `.env.local`:

```dotenv
EXPO_PUBLIC_IROH_RELAY_URLS=https://relay.example.com
EXPO_PUBLIC_IROH_RELAY_TOKEN=<limited-scope client token>
```

Browsers cannot use UDP hole punching, so iroh runs relay-only there; native clients
retain direct IP and BLE paths alongside the same relay map. Connections remain iroh
E2E-encrypted, and the app-layer envelope is interoperable with native because the WASM
crate reuses `rust/src/crypto.rs` (postcard + RFC 8439 ChaCha20-Poly1305 + HPKE + ed25519).
The token stays out of Git, but it is necessarily embedded in client builds because each
client presents it to the relay.

**Durable trail (iroh-docs) on web.** The web path implements the full durable trail —
`docsWrite`, `syncTrail`, `readTrail`, `pruneTrail`, `docTicket` — by reusing the native
range-reconciliation logic verbatim (`rust/src/docs.rs` is `#[path]`-included by the WASM
crate, exactly like `crypto.rs`). `iroh-docs` `0.101` / `iroh-blobs` `0.103` compile to
`wasm32-unknown-unknown` when built with `default-features = false` (this drops the
`fs-store`/`rpc`/redb backends, which are native-only). Reconciliation runs over the same
relay-reachable connections as gossip.

Because a browser has no filesystem, both the iroh-blobs content store (`MemStore`) and the
iroh-docs replica (`Docs::memory()`) are **in-memory**. **Durability caveat:** unlike native
(which persists to disk under the app sandbox), the web trail is ephemeral — it is lost on
page reload / tab close. Range reconciliation still recovers missed fixes within a live
session and across peers, and the sealed envelope bytes are byte-identical to native, so a
web peer's durable entries interoperate with native peers (and per-recipient revocation
carries over). Recovered fixes surface via `onFix` with `backfill: true`; sync progress via
`onSync`. If a browser-persistent store is needed later, wire iroh-blobs/iroh-docs to an
IndexedDB-backed store.

## Proving the A→B gate

1. Build the dev client on the iPhone (A) and the Android (B).
2. Open the **Friends** tab on both; each shows its `streetcryptid://contact?…` link.
3. Open A's one-time pairing link on B. Compare the visual check over a trusted call: one phone
   shows an ASCII figure, the other chooses it from four, then the displaying phone confirms.
4. Verify neither friend nor sharing grant appears until both people complete that check.
5. On A, tap **Share** next to B, nudge the point, tap **Broadcast** → B's Friends screen
   lists the decrypted fix under "Incoming fixes".
6. Revoke: on A tap **Sharing** to turn it off → B stops receiving new (decryptable)
   fixes, proving per-recipient revocation end-to-end.

## Status / next

- `iroh-docs` durable trail recovery via range-based reconciliation — **done** on both
  native (persistent fs replica) and web (in-memory replica; see §5 durability caveat).
  Surfaced via `docsWrite`/`syncTrail`/`readTrail`/`pruneTrail`/`docTicket` + `onFix{backfill}`/`onSync`.
- Profile sync (§3), bilateral pairing (§4), and honest BLE status (§2) — **bridged** to JS.
  The Kotlin (`just bindgen-android`) and Swift (`--language swift`, host lib) UniFFI bindings are
  regenerated and the Expo wrappers expose `publishProfile`/`profileTicket`/`importProfileTicket`/
  `readProfile`/`pollProfileEvents`, `setPairingReady`/`pairingReady`/`createPairInvite`/
  `initiatePair`/`initiatePairByToken`/`initiatePairNearby`/`respondPair`/`pollPairEvents`/
  `pairState`/`listPairSessions`/`pairSasChallenge`/`submitPairChoice`/
  `confirmPairDisplay`/`cancelPair`/`pairResult`/`encodePairInvite`/`decodePairInvite`, and
  `bleAvailable`/`bleCapabilities`/`nearbyBlePeers`/`bleHasScanHint`. Byte fields cross the bridge
  as lowercase hex; enums as camelCase strings; U64 epochs/timestamps as JS numbers. The web
  (WASM) build reports these unavailable (empty/false/null) and throws only on explicit pairing
  actions — location sharing + durable trail keep working.
- Background execution — **done** in the app layer (`src/features/social/net/background/`) over
  `expo-location` + `expo-task-manager`; see ARCHITECTURE.md §9.
- **iOS XCFramework** is generated automatically for EAS device builds by the pre-install
  hook. For local device + simulator builds, regenerate the Swift bindings and both
  XCFramework slices with `just bindgen-ios` on macOS + Xcode (README §2).
- Relay deployment configuration stays outside this public repository.
- Pin `iroh-gossip`/`iroh-docs` versions carefully; they are pre-1.0 and move fast.
